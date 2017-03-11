  module.exports = {
    ERROR_TYPE:{
      NOT_FOUND:404,
      SYSTEM:500,
      ACCESS_DENIED:403
    },
    CONSISTENCY:{
      QUEUED: 0,//get a consistency report back after the subscribes have been notified
      DEFERRED: 1,//queues the publication, then calls back
      TRANSACTIONAL: 2,//waits until all recipients have been written to
      ACKNOWLEDGED: 3//waits until all recipients have acknowledged
    },
    CLIENT_STATE:{
      UNINITIALIZED:0,
      ACTIVE:1,
      DISCONNECTED:2,
      ERROR:3,
      RECONNECTING:4,
      CONNECTING:5,
      CONNECTED:6,
      DISCONNECTING:7
    }
  };