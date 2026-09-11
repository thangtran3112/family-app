locals {
  clerk_dns_records = {
    frontend_api = {
      name    = "clerk.tobytran.dev"
      content = "frontend-api.clerk.services"
    }
    accounts = {
      name    = "accounts.tobytran.dev"
      content = "accounts.clerk.services"
    }
    mail = {
      name    = "clkmail.tobytran.dev"
      content = "mail.isbd4mdbk2ld.clerk.services"
    }
    dkim1 = {
      name    = "clk._domainkey.tobytran.dev"
      content = "dkim1.isbd4mdbk2ld.clerk.services"
    }
    dkim2 = {
      name    = "clk2._domainkey.tobytran.dev"
      content = "dkim2.isbd4mdbk2ld.clerk.services"
    }
  }
}

resource "cloudflare_dns_record" "clerk" {
  for_each = local.clerk_dns_records

  zone_id = data.cloudflare_zone.expense_tax.id
  name    = each.value.name
  type    = "CNAME"
  content = each.value.content
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "clerk_dmarc" {
  zone_id = data.cloudflare_zone.expense_tax.id
  name    = "_dmarc.tobytran.dev"
  type    = "TXT"
  content = "v=DMARC1; p=none; adkim=s; aspf=s"
  ttl     = 3600
  proxied = false
  comment = "Clerk production email authentication"
}
