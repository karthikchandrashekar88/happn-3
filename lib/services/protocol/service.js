var util = require('util'),
  EventEmitter = require('events').EventEmitter,
  Promise = require('bluebird'),
  async = require('async'),
  constants = require('../../constants');

module.exports = ProtocolService;

function ProtocolService(opts) {

  if (!opts) opts = {};

  this.log = opts.logger.createLogger('Protocol');
  this.log.$$TRACE('construct(%j)', opts);

  this.__protocolStats = {};
  this.__stackCache = {};

  this.__benchmarkStats = {};
}

// Enable subscription to key lifecycle events
util.inherits(ProtocolService, EventEmitter);

ProtocolService.prototype.stats = function () {
  return {
    protocols: Object.keys(this.config.protocols),
    protocolCounts: this.__protocolStats,
    stackCacheSize: Object.keys(this.__stackCache).length,
    benchmarks: this.__benchmarkStats
  }
};

ProtocolService.prototype.__getSystemStack = function (protocol, message) {

  var _this = this;

  var stack = [_this.happn.services.layer.begin(message)];
  var stackKey = message.action + (message.options ? JSON.stringify(message.options) : '');

  if (!_this.__stackCache[stackKey]) {

    var cachedStack = [];

    if (_this.config.loggingEnabled) cachedStack.push(_this.happn.services.layer.log);

    cachedStack.push(protocol.transformSystem);

    if (_this.config.outboundLayers && _this.config.outboundLayers.length > 0) {

      _this.config.outboundLayers.forEach(function (outboundLayer) {
        cachedStack.push(outboundLayer);
      });
    }

    _this.__stackCache[stackKey] = cachedStack;
  }

  stack.push.apply(stack, _this.__stackCache[stackKey]);

  return stack;
};

//takes outbound system requests and transforms them into ones the client understands

ProtocolService.prototype.processSystem = function (message, respond) {

  var _this = this;

  var protocol = _this.__getProtocol(message.session.protocol); //happn by default

  if (!protocol) return respond(_this.happn.services.error.SystemError('unknown system protocol: ' + message.session.protocol, 'protocol'));

  async.waterfall(_this.__getSystemStack(protocol, message), respond);
};

ProtocolService.prototype.benchmarkStart = function (message, callback) {

  if (!this.__benchmarkStats[message.request.action]) this.__benchmarkStats[message.request.action] = {
    current: {},
    count: 0,
    totalTime: 0,
    avg: 0
  };

  this.__benchmarkStats[message.request.action].current[message.id] = Date.now();

  this.__benchmarkStats[message.request.action].count++;

  callback(null, message);

};

ProtocolService.prototype.benchmarkEnd = function (message, callback) {

  var stat = this.__benchmarkStats[message.request.action];

  var timespan = Date.now() - stat.current[message.id];

  delete stat.current[message.id];

  stat.totalTime += timespan;

  stat.avg = stat.totalTime / stat.count;

  callback(null, message);

};

ProtocolService.prototype.__getStackKey = function(transformed){

  if (transformed.request.action == 'off') return 'off';//the options could have ephemeral properties (referenceId)
                                                        // , no stack inclusions are made based on request options so this is a safe key

  if (transformed.request.action == 'on') return 'on';//the options could have ephemeral properties (listenerId)
                                                      // , no stack inclusions are made based on request options so this is a safe key

  return transformed.request.action + '_' + (transformed.request.options ? JSON.stringify(transformed.request.options) : '');
};

/*
 This method will cache a stack of operations that need to be performed on each message, the idea is that instead of
 having to subject each incoming message to a series of operations based on the message options and the configuration
 of the protocol service, we create a protocol stack, keyed by the message action and options and cache it for reuse
 on subsequent messages.
 */
ProtocolService.prototype.__getInboundStack = function (transformed) {

  var stack = [this.happn.services.layer.begin(transformed)];

  var stackKey = this.__getStackKey(transformed);

  if (!this.__stackCache[stackKey]) {

    var cachedStack = [];

    if (this.config.inboundLayers && this.config.inboundLayers.length > 0) {
      var _this = this;
      _this.config.inboundLayers.forEach(function (inboundLayer) {
        if (inboundLayer.resolve != null) cachedStack.push(inboundLayer);
        else cachedStack.push(Promise.promisify(inboundLayer));
      });
    }

    if (this.config.benchMarkEnabled) cachedStack.push(this.benchmarkStart.bind(this));

    if (this.config.loggingEnabled) cachedStack.push(this.happn.services.layer.log);

    if (this.config.secure) {

      if (['get', 'set', 'on', 'remove'].indexOf(transformed.request.action) > -1) cachedStack.push(this.happn.services.layer.security.processAuthorize);
    }

    if (transformed.request.action === 'request-nonce') cachedStack.push(this.happn.services.layer.security.processNonceRequest);

    if (['set', 'remove'].indexOf(transformed.request.action) >= 0) {

      if (transformed.request.action === 'set') {

        if (transformed.request.options && transformed.request.options.noStore) cachedStack.push(this.happn.services.layer.data.doNoStore);

        else {

          if (this.config.secure) cachedStack.push(this.happn.services.layer.data.doSecureStore);

          else cachedStack.push(this.happn.services.layer.data.doStore);
        }
      } else cachedStack.push(this.happn.services.layer.data.doRemove);

      //this allows for when we have no options
      if (!transformed.request.options || !transformed.request.options.noPublish) {

        cachedStack.push(this.happn.services.layer.subscription.processGetRecipients); //get our subscribers attach them to our message

        cachedStack.push(this.happn.services.layer.publisher.processPublish); //get our subscribers attach them to our message

      }
    } else if (transformed.request.action === 'get') {

      cachedStack.push(this.happn.services.layer.data.doGet);

    } else if (transformed.request.action == 'on') {
      //NB if any inclusion decisions are made based on options,
      // please ensure that the key is generated properly in __getStackKey
      cachedStack.push(this.happn.services.layer.subscription.prepareSubscribeMessage);
      cachedStack.push(this.happn.services.layer.subscription.processSubscribe);

    } else if (transformed.request.action == 'off') {
      //NB if any inclusion decisions are made based on options,
      // please ensure that the key is generated properly in __getStackKey
      cachedStack.push(this.happn.services.layer.subscription.prepareSubscribeMessage);
      cachedStack.push(this.happn.services.layer.subscription.processUnsubscribe);

    } else if (transformed.request.action === 'describe') {

      cachedStack.push(this.happn.services.layer.system);

    } else if (transformed.request.action === 'configure-session') {

      cachedStack.push(this.happn.services.layer.session.configured);

    } else if (transformed.request.action === 'login') {

      if (this.config.secure) cachedStack.push(this.happn.services.layer.security.processLogin);
      else cachedStack.push(this.happn.services.layer.security.doUnsecureLogin);

    } else if (transformed.request.action === 'disconnect') {

      cachedStack.push(this.happn.services.layer.session.processDisconnect);

    } else if (transformed.request.action === 'ack') {

      cachedStack.push(this.happn.services.layer.publisher.processAcknowledge);

    } else if (transformed.request.action === 'revoke-session') {

      cachedStack.push(this.happn.services.layer.session.processRevokeSession);
    }

    if (this.config.benchMarkEnabled) cachedStack.push(this.benchmarkEnd.bind(this));

    if (this.config.secure && this.happn.services.security.config.audit) cachedStack.push(this.happn.services.layer.security.doAudit);

    this.__stackCache[stackKey] = cachedStack;
  }

  stack.push.apply(stack, this.__stackCache[stackKey]);

  return stack;
};

ProtocolService.prototype.__respondMessageIn = function (protocol, message, respond, e) {

  try {
    if (e) {
      message.error = e;
      return protocol.fail(message, respond);
    }
    return protocol.success(message, respond);
  } catch (e) {
    this.happn.services.error.handleSystem(e, 'ProtocolService.__respondMessageIn', constants.ERROR_SEVERITY.MEDIUM);
  }
};

ProtocolService.prototype.__respondMessageInLayers = function (protocol, message, respond, e) {

  try {

    var _this = this;

    var responseLayers = [_this.happn.services.layer.begin(message)];

    if (e) {

      message.error = e;
      responseLayers.push(protocol.fail);

    } else responseLayers.push(protocol.success);

    if (_this.config.outboundLayers && _this.config.outboundLayers.length > 0)
      responseLayers.push.apply(responseLayers, _this.config.outboundLayers);

    async.waterfall(responseLayers, function (e, message) {

      if (e) return _this.happn.services.error.handleSystem(e, 'ProtocolService.__respondMessageInLayers', constants.ERROR_SEVERITY.MEDIUM);

      respond(null, message);
    });

  } catch (e) {
    this.happn.services.error.handleSystem(e, 'ProtocolService.__respondMessageInLayers', constants.ERROR_SEVERITY.MEDIUM);
  }
};

ProtocolService.prototype.executeInboundStack = Promise.promisify(function (transformed, callback) {

  var _this = this;

  return async.waterfall(
    _this.__getInboundStack(transformed),

    callback
  );
});

ProtocolService.prototype.__getProtocol = function(sessionProtocol){

  this.__updateProtocolStats(sessionProtocol);

  var major = sessionProtocol.split('.')[0];

  return this.config.protocols[major]; //happn by default
};

ProtocolService.prototype.processMessageIn = function (message, callback) {

  var _this = this;

  var protocol = _this.__getProtocol(message.session.protocol);

  if (!protocol) return callback(_this.happn.services.error.SystemError('unknown inbound protocol: ' + message.session.protocol, 'protocol'));

  protocol.transformIn(message)

    .then(function (transformed) {
      return _this.executeInboundStack(transformed)
    })
    .then(function (transformed) {
      _this.__respondMessageIn(protocol, transformed, callback);
    })
    .catch(function (e) {
      _this.__respondMessageIn(protocol, message, callback, e.cause ? e.cause : e);
    });
};

var cachedProtocol;

ProtocolService.prototype.current = function () {

  if (!cachedProtocol) cachedProtocol = 'happn_' + this.happn.services.system.package.protocol;

  return cachedProtocol;
};

ProtocolService.prototype.__getOutboundStack = function (transformed) {

  var stack = [this.happn.services.layer.begin(transformed)];

  if (!this.__stackCache['system:outbound']) {

    var cachedStack = [];

    //if (this.config.secure) cachedStack.push(this.happn.services.layer.security.out);
    if (this.config.loggingEnabled) cachedStack.push(this.happn.services.layer.log);

    if (this.config.outboundLayers && this.config.outboundLayers.length > 0) {
      var _this = this;
      _this.config.outboundLayers.forEach(function (outboundLayer) {
        cachedStack.push(outboundLayer);
      });
    }

    this.__stackCache['system:outbound'] = cachedStack;
  }

  stack.push.apply(stack, this.__stackCache['system:outbound']);

  return stack;
};

ProtocolService.prototype.__updateProtocolStats = function(protocol){

  var _this = this;

  if (_this.__protocolStats[protocol] == null) _this.__protocolStats[protocol] = 0;

  _this.__protocolStats[protocol]++;
};

ProtocolService.prototype.processMessageOut = function (message, respond) {

  var _this = this;

  var protocol = this.__getProtocol(message.session.protocol); //happn by default

  if (!protocol) return respond(_this.happn.services.error.SystemError('unknown inbound protocol: ' + message.session.protocol, 'protocol'));

  protocol.transformOut(message, function (e, transformed) {

    if (e) return respond(e);

    return async.waterfall(
      _this.__getOutboundStack(transformed),

      function (e, publication) {

        if (e) return respond(e);

        protocol.emit(publication, message.session, respond);
      }
    );
  });
};

ProtocolService.prototype.initialize = Promise.promisify(function (config, callback) {

  if (!config) config = {};

  if (!config.protocols) config.protocols = {};

  var packageProtocol = require('../../../package.json').protocol;

  this.__latest = require('./happn_' + packageProtocol).create();
  this.__earliest = require('./happn_1').create();

  config.protocols['happn_' + packageProtocol] = this.__latest;
  //the earliest clients have no protocol version, so we use the earliest by default
  config.protocols['happn'] = this.__earliest;

  for (var i = 1; i < packageProtocol; i++)
    if (!config.protocols['happn_' + i]) config.protocols['happn_' + i] = require('./happn_' + i).create();

  for (var protocolKey in config.protocols) {

    var protocol = config.protocols[protocolKey];

    protocol.happn = this.happn;

    //waterfall messes with "this" - this makes the code cleaner

    protocol.protocolVersion = protocolKey;

    protocol.transformIn = protocol.transformIn.bind(protocol);
    protocol.transformOut = protocol.transformOut.bind(protocol);
    protocol.transformSystem = protocol.transformSystem.bind(protocol);
    protocol.emit = protocol.emit.bind(protocol);
    protocol.fail = protocol.fail.bind(protocol);
    protocol.success = protocol.success.bind(protocol);
    protocol.initialize();
  }

  this.config = config;

  if (this.config.outboundLayers && this.config.outboundLayers.length > 0) this.__respondMessageIn = this.__respondMessageInLayers;

  return callback();

});
