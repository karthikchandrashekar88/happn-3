describe('h2_system_health_error_handling_sanity', function () {

  var happn = require('../lib/index');
  var serviceInstance;
  var expect = require('expect.js');
  var constants = happn.constants;

  var getService = function (config, callback) {
    happn.service.create(config,
      callback
    );
  };

  before('it starts completely defaulted service', function (done) {

    getService({
      secure: true
    }, function (e, service) {

      if (e) return done(e);

      serviceInstance = service;

      done();
    });
  });

  after('stop the test service', function (callback) {
    serviceInstance.stop(callback);
  });

  it('logs errors via the error service, ensures system health changes as required', function (done) {

    var e = new Error('TEST ERROR');

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.EXCELLENT);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.LOW);

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.FAIR);

    expect(serviceInstance.services.system.__stats.HEALTH[constants.ERROR_SEVERITY.LOW]).to.be(1);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.LOW);

    expect(serviceInstance.services.system.__stats.HEALTH[constants.ERROR_SEVERITY.LOW]).to.be(2);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.MEDIUM);

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.TAKING_STRAIN);

    expect(serviceInstance.services.system.__stats.HEALTH[constants.ERROR_SEVERITY.MEDIUM]).to.be(1);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.LOW);

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.TAKING_STRAIN);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.HIGH);

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.POOR);

    serviceInstance.services.system.resetStats();

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.EXCELLENT);

    serviceInstance.services.error.handleSystem(e, 'test', constants.ERROR_SEVERITY.FATAL);

    expect(serviceInstance.services.system.__stats.HEALTH.STATUS).to.be(constants.SYSTEM_HEALTH.POOR);

    expect(serviceInstance.services.system.__stats.HEALTH.lastError.message).to.be('Error: TEST ERROR');

    expect(serviceInstance.services.system.__stats.HEALTH.lastError.severity).to.be(constants.ERROR_SEVERITY.FATAL);

    expect(serviceInstance.services.system.__stats.HEALTH.lastError.area).to.be('test');

    done();
  });

  it('tests failures in the data service', function (done) {

    var testProvider = serviceInstance.services.data.db('/test/path');

    testProvider.__oldFindOne = testProvider.findOne;

    testProvider.findOne = function(criteria, fields, callback){
      return callback(new Error('test error'));
    };

    serviceInstance.services.data.getOneByPath('/test/path', null, function(e){

      expect(e.toString()).to.be('SystemError: test error');

      testProvider.findOne = testProvider.__oldFindOne;

      done();
    });

  });

  xit('tests failures in the protocol service', function (done) {

  });

  xit('tests failures in the subscription service', function (done) {

  });

  xit('tests failures in the publisher service', function (done) {

  });

});