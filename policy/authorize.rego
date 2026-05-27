# OPA policies (v2) — mount into security-agent OPA sidecar
package sre.authorize

default allow = false

allow {
  input.plan.action == "restart"
  not prod_namespace
}

prod_namespace {
  lower(input.namespace) == "production"
}

allow {
  input.plan.action == "git_patch"
  input.hil_approved == true
}
