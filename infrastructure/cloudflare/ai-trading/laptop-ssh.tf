# Operator SSH to the host through the ai-trading tunnel, gated by Cloudflare
# Access. Off unless laptop_ssh_enabled; see laptop-ssh-variables.tf.
#
# What this file does not own: the `ssh://` ingress line (main.tf's ingress
# concat, one list that must end with the 404 catch-all) and the proxied CNAME
# to the tunnel (main.tf's local.tunnel_hostnames, the same
# cloudflare_dns_record.tunnel every other tunnel hostname uses). Both turn on
# with the same variable.
#
# Attribute names checked against the pinned provider's schema
# (`terraform providers schema -json`, cloudflare/cloudflare v5.26.0).
#
# The Zero Trust organization (team name, one-time-PIN login) must already
# exist in the account: infrastructure/cloudflare/zero-trust/ holds that
# decision and is not applied by this root. Access has not been enabled
# successfully on this account yet (see main.tf), so a first apply with
# laptop_ssh_enabled=true can fail at these two resources until the operator
# onboards Zero Trust. The README lists it as an apply-time step.

resource "cloudflare_zero_trust_access_policy" "laptop_ssh" {
  count = var.laptop_ssh_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "laptop-ssh: owner only"
  decision   = "allow"

  # The API wants a non-empty `include` on an allow policy. Naming the same
  # identity in `include` and `require` keeps the policy closed if either block
  # is ever edited: `require` is an AND on every request, `include` an OR.
  include = [{ email = { email = var.laptop_ssh_owner_email } }]
  require = [{ email = { email = var.laptop_ssh_owner_email } }]

  lifecycle {
    precondition {
      condition     = var.laptop_ssh_owner_email != ""
      error_message = "Refusing to create the laptop-ssh Access policy without an owner identity."
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "laptop_ssh_ci" {
  count = var.laptop_ssh_enabled && var.laptop_ssh_ci_service_token_id != "" ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "laptop-ssh: CI service token"

  # Service Auth, not allow. A service token is only honoured by a policy whose
  # action is Service Auth (API decision `non_identity`); under `allow` the edge
  # recognises the token headers but still answers 403 and the SSH websocket
  # never opens. Service Auth policies are evaluated before allow policies.
  # The CI service token authenticates headlessly (no browser/PIN), so the
  # GitHub deploy runner can ssh to the host through Cloudflare Access.
  decision = "non_identity"
  include  = [{ service_token = { token_id = var.laptop_ssh_ci_service_token_id } }]
}

resource "cloudflare_zero_trust_access_application" "laptop_ssh" {
  count = var.laptop_ssh_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "laptop-ssh"
  type       = "ssh"
  domain     = var.laptop_ssh_hostname

  # How long `cloudflared access ssh` keeps its token before the browser login
  # repeats. 7 days (168h) — the SSH key stays the hard gate underneath.
  session_duration     = "168h"
  app_launcher_visible = false

  policies = concat(
    [
      {
        id         = cloudflare_zero_trust_access_policy.laptop_ssh[0].id
        precedence = 1
      },
    ],
    var.laptop_ssh_ci_service_token_id != "" ? [
      {
        id         = cloudflare_zero_trust_access_policy.laptop_ssh_ci[0].id
        precedence = 2
      },
    ] : [],
  )
}
