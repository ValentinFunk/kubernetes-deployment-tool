# Kubernetes Deployment Helper

This script helps you __deploy microservices into Kubernetes__. It monitors the Deployment, waits until it is truly finished (Services are available) and performs a Rollback on failure. 

It is called like this:
```
echo deployment.yaml | node index.js 
```
The deployment.yaml file should contain service and deployment definitions.

## How it works

1. The current versions of all active deployments are fetched.
2. `kubectl apply` is called to apply changes. For deployments kubectl rollout status is called to wait until replicasets have been updated.
3. The new versions of all applied deployments are fetched and compared to the versions from step 1 to find out which have been changed.
4. The cluster is polled to wait until the desired amount of replicas is available (`deployment.status.availableReplicas == deployment.spec.replicas`)
5. For each service that was included in the yaml: Get Pods and wait until at least one is healthy & ready (readinessProbe passed)
6. If a failure is detected in step 4 or 5 (or the checks have timed out after the specified interval) all changed deployments are rolled back via `kubectl rollout undo`.

## Setup 
The script calls kubectl processes instead of using the API, so simply configure a kubectl in the path. 

Additional, optional configuration via Environment Variables:
- `DEPLOY_WAIT_TIMEOUT` (default 120): Timeout in s for the changing of ReplicaSets.
- `REPLICA_WAIT_TIMEOUT` (default 120): Timeout in s for reaching the desired amount of Replicas. 
- `SERVICE_READY_TIMEOUT` (default 120): Timeout in s for waiting until a Service is ready.
- `KUBE_NAMESPACE`: Namespace to use. Uses the one configured with the current context via kubectl if not defined.

## Example

In this example the products-service deployment was updated:
```
cat target-state.yaml | node index.js kubectl rollout status deployment mysql
Calling kubectl to apply changes...
[KUBECTL] service/mongodb
[KUBECTL] deployment/mongodb
[KUBECTL] service/products-service
[KUBECTL] configmap/products-service-config
[KUBECTL] deployment/products-service
[KUBECTL] service/mysql
[KUBECTL] secret/mysql-pass
[KUBECTL] deployment/mysql
[KUBECTL] service/users-service
[KUBECTL] deployment/users-service
[KUBECTL] configmap/service-endpoints
[KUBECTL] service/web-service
[KUBECTL] deployment/web-service
Waiting until deployments mongodb, products-service, mysql, users-service, web-service have been applied.
All deployments have been rolled out. Fetching changes...
        mongodb UNCHANGED
        mysql UNCHANGED
        products-service V 39 => 41
        users-service UNCHANGED
        web-service UNCHANGED
Waiting for services to become available...
        mongodb running & ready
        web-service running & ready
        mysql running & ready
        products-service running & ready
        users-service running & ready
Deployment Successful
```
