var request = require('request-promise'),
    Promise = require('bluebird'),
    exec = require('child-process-Promise').exec,
    spawn = require('child_process').spawn,
    _ = require('lodash'),
    repeatUntilSuccessful = require('./repeatUntilSuccessful');

var deploymentWaitTimeout = process.env.DEPLOY_WAIT_TIMEOUT || 120;
var replicaAvailableTimeout = process.env.REPLICA_WAIT_TIMEOUT || 120;
var serviceReadyTimeout = process.env.SERVICE_READY_TIMEOUT || 120;

var namespaceArg = "";
if (process.env.KUBE_NAMESPACE) {
  namespaceArg = `--namespace=${process.env.KUBE_NAMESPACE}`;
}

// A deployment error causes a rollback of the specified deployments
function DeploymentError(message, deployments) {
  this.name = "DeploymentError";
  this.message = (message || "");
  this.deployments = (deployments || "");
}
DeploymentError.prototype = Object.create(Error.prototype);

// Wrapper function to spawn a kubectl process and parse stdout as JSON
function kubectl(args) {
  return exec(`kubectl ${namespaceArg} -o json ${args}`).then(function(result) {
    return JSON.parse(result.stdout);
  });
}

// Poll a deployment until availableReplicas == spec.replicas
function pollAvailableReplicas(deploymentName, timeout) {
  return repeatUntilSuccessful(() => {
    return kubectl('get deployment ' + deploymentName).then((deployment) => {
      return deployment.status.availableReplicas >= deployment.spec.replicas && deployment.status.availableReplicas;
    });
  }, 1000, replicaAvailableTimeout * 1000);
}

function waitForLoadbalancer(serviceName, timeout) {
  return repeatUntilSuccessful(() => {
    return kubectl(`get service ${serviceName}`)
    .then(_.property('status.loadBalancer.ingress[0].ip'));
  }, 1000, serviceReadyTimeout * 1000);
}

function waitForService(serviceName, timeout) {
  var selectorArg;
  return Promise.resolve().then(() => {
    return kubectl(`get service ${serviceName}`);
  }).then((service) => {
    var selectorPairs = _.toPairs(service.spec.selector);
    var selectorArray = selectorPairs.map((pair) => {
      return pair[0] + "=" + pair[1];
    });
    selectorArg = "-l " + selectorArray.join(',');
  })
  .then(() => {
    return repeatUntilSuccessful(() => {
      return kubectl(`get pods ${selectorArg}`)
      .then((pods) => {
        return _.some(pods.items, (pod) => {
          var isRunning = pod.status.phase == "Running";
          var isReady = false;
          var readyCondition = _.find(pod.status.conditions, {type: "Ready"});
          if (readyCondition && readyCondition.status == "True") {
            isReady = true;
          }
          return isReady && isRunning;
        });
      });
    }, 1000, serviceReadyTimeout * 1000);
  });
}

function performDeploymentAndWaitUntilApplied(deployedGenerations) {
  var deploymentFinishedPromises = []; // Holds rollout wait promises
  var configuredObjects = {deployment: []}; // Holds configured Objects (service/deployment/secret, whatever way in the YAML)
  var failedDeployments = [];

  return Promise.resolve()
  .then(() => {
    console.log("Calling kubectl to apply changes...");
    return new Promise((resolve, reject) => {
      var kubectlSpawned = spawn('kubectl', [namespaceArg, 'apply', '-o', 'name', '-f', '-']);
      process.stdin.pipe(kubectlSpawned.stdin);

      kubectlSpawned.stdout.on('data', function (data) {
        var msg = data.toString();
        process.stdout.write('[KUBECTL] ' + msg);

        var regex = /([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_]+)/g;
        var matches = regex.exec(msg);
        if (matches) {
          var type = matches[1];
          var name = matches[2];
          if (!configuredObjects[type]) {
            configuredObjects[type] = [name];
          } else {
            configuredObjects[type].push(name);
          }

          if (type == "deployment") {
            var promise = exec('kubectl rollout status deployment ' + name, {timeout: deploymentWaitTimeout * 1000}).catch((error) => {
              console.error("[kubectl rollout status error]", error);
              failedDeployments.push(name);
              return Promise.resolve();
            });
            deploymentFinishedPromises.push(promise);
          }
        }
      });

      kubectlSpawned.stderr.on('data', function (data) {
        process.stderr.write('[KUBECTL] ERR: ' + data.toString());
      });

      kubectlSpawned.on('close', (code) => {
        if (code == 0) {
          return resolve();
        } else {
          return reject('kubectl process exited with code ' + code);
        }
      });
    });
  }).then(() => {
    console.log("Waiting until deployments " + configuredObjects['deployment'].join(', ') + " have been applied.");
    return Promise.all(deploymentFinishedPromises).then(() => {
      if (failedDeployments.length > 0) {
        throw new DeploymentError("Rollout status failed for deployments", failedDeployments);
      }
    });
  }).then(() => {
    return configuredObjects;
  });
}

function performDeployment() {
  var deployedGenerations;
  var configuredServices;
  var changedDeployments;
  var configuredObjects;

  return kubectl('get deployments')
  .then(function storeDeployedGenerations(deployments) {
    deployedGenerations = _(deployments.items).map((item) => {
      return [item.metadata.name, item.status.observedGeneration];
    }).fromPairs().value();
    return deployedGenerations;
  })
  .then(performDeploymentAndWaitUntilApplied)
  .then(function(_configuredObjects) {
    configuredObjects = _configuredObjects;
    console.log("All deployments have been rolled out. Fetching changes...");
    return kubectl('get deployments');
  })
  .then(function findChangedDeployments(deployments) {
    deployments = deployments.items;
    // Check only deployments that were updated during the apply command
    deployments = _.filter(deployments, (deployment) => {
      return configuredObjects.deployment.includes(deployment.metadata.name);
    });

    changedDeployments = [];
    var newDeployedGenerations = _(deployments).map((deployment) => {
      return [deployment.metadata.name, deployment.status.observedGeneration];
    }).fromPairs();

    newDeployedGenerations.forEach((generation, deploymentName) => {
      if (deployedGenerations[deploymentName]) {
        var oldGeneration = deployedGenerations[deploymentName];
        if (oldGeneration != generation) {
          // Deployment was updated to a new version
          console.log(`\t${deploymentName} V ${oldGeneration} => ${generation}`);
          changedDeployments.push(deploymentName);
        } else {
          console.log(`\t${deploymentName} UNCHANGED`);
        }
      } else {
        // Deployment is new
        console.log(`\t${deploymentName} ADDED`);
        changedDeployments.push(deploymentName);
      }
    });
  })
  .then(function verifyDeploymentReplicasets() {
    // Wait until replicasets have scaled, rollback those that failed to scale up
    var failedDeployments = [];
    return Promise.map(changedDeployments, (deploymentName) => {
      return pollAvailableReplicas(deploymentName)
      .then((replicaNum) => {
        console.log(`\t${deploymentName} replicas updated (${replicaNum} replicas)`);
      }).catch((error) => {
        console.error(`\t${deploymentName} ERROR: ${error.message}`);
        failedDeployments.push(deploymentName);
        return Promise.resolve();
      });
    }).then(() => {
      if (failedDeployments.length > 0) {
        throw new DeploymentError("Failed to verify replicasets for", failedDeployments);
      }
    });
  })
  .then(function waitForServices() {
    console.log("Waiting for services to become available...");
    if (configuredObjects.service && configuredObjects.service.length > 0) {
      var failedServices = [];
      return Promise.map(configuredObjects.service, (serviceName) => {
        return waitForService(serviceName).then(() => {
          console.log(`\t${serviceName} running & ready`);
        }).catch((error) => {
          console.log(`\t${serviceName} ERROR ${error.message}`);
          failedServices.push(serviceName);
          return Promise.resolve();
        });
      }).then(function() {
        if (failedServices.length > 0) {
          // this requires ServiceName == DeploymentName
          throw new DeploymentError("Failed to verify services for", failedServices);
        }
      });
    } else {
      console.log("SKIPPING: No services were configured");
    }
  })
  .then(function waitForLbs() {
    console.log("Waiting for endpoints to become available...");
    if (configuredObjects.service && configuredObjects.service.length > 0) {
      var failedServices = [];
      return Promise.map(configuredObjects.service, (serviceName) => {
        return waitForLoadbalancer(serviceName).then((endpoint) => {
          console.log(`\t${serviceName} at ${endpoint}`);
        }).catch((error) => {
          console.log(`\t${serviceName} ERROR ${error.message}`);
          failedServices.push(serviceName);
          return Promise.resolve();
        });
      }).then(function() {
        if (failedServices.length > 0) {
          // this requires ServiceName == DeploymentName
          throw new DeploymentError("Failed to get endpoints for", failedServices);
        }
      });
    } else {
      console.log("SKIPPING: No services were configured");
    }
  })
  .then(() => {
    console.log("Deployment Successful");
  })
  .catch(function(e) {
    if (e instanceof DeploymentError) {
      var deploymentsToRollback = _.filter(e.deployments, changedDeployments.includes.bind(changedDeployments));
      console.log("DEPLOYMENT FAILED: " + e.message, "Rolling Back Deployments " + deploymentsToRollback.join(', '));
      return Promise.map(deploymentsToRollback, (deployment) => {
        return exec(`kubectl rollout undo deployment ${deployment} ${namespaceArg}`).then((p) => {
          console.log(p.stdout);
        });
      })
      .then(() => {
        console.log("Rollback Finished");
      }, (error) => {
        console.log("Error rolling back", error);
      });
    } else {
      console.error(e);
    }
  });
}

performDeployment();
