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
5. For each service that was included in the applied YAML: 1) Pods are polled and it waits until at least one is healthy & ready (readinessProbe passed) 2) If `service.spec.type == "LoadBalancer"` the script waits until the Load Balancer has been created and an external endpoint is available
6. a) If a failure is detected in step 4 or 5 (or the checks have timed out after the specified interval) all changed deployments are rolled back via `kubectl rollout undo`.
   
   b) If the deployment was successful, deployments that were changed (c.f. step 3) are written to deployments.txt (one deployment per line). At this stage you could run your e2e tests and use `kubectl rollout undo` if they fail.

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
        products-service V 10 => 12
        users-service UNCHANGED
        web-service UNCHANGED
        products-service replicas updated (1 replicas)
Waiting for services to become available...
        products-service running & ready
        mysql running & ready
        mongodb running & ready
        web-service running & ready
        users-service running & ready
Waiting for endpoints to become available...
        mongodb at ClusterIP(10.115.247.255)
        mysql at ClusterIP(10.115.241.2)
        web-service at 146.138.25.181
        products-service at 120.211.81.47
        users-service at 104.157.69.189
Deployment Successful, writing deployments.txt...
```
