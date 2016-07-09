var Promise = require('bluebird');

module.exports = function repeatUntilSuccessful(op, delay, timeout) {
  var timedOut = false;

  var repeater = function( ) {
    if (timedOut) {
      return;
    }

    return Promise.resolve().then(op)
    .then(function(success) {
      if (!success) {
        return Promise.delay(delay)
          .then(repeater.bind(null, op, delay));
      }
    });
  }

  var promise = Promise.resolve().then(repeater);
  if (timeout) {
    promise = promise.timeout(timeout)
    .catch(Promise.TimeoutError, (error) => {
      timedOut = true;
      throw error; //Rethrow
    });
  }
  return promise;
}
