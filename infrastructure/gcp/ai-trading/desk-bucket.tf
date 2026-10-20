# Public data-free Desk export. Separate bucket/identity from upstream apps.
resource "google_storage_bucket" "desk_static" {
  project                     = var.project_id
  name                        = "${var.project_id}-ai-trading-desk"
  location                    = "US"
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "desk_static_public_read" {
  bucket = google_storage_bucket.desk_static.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_service_account" "desk_static_uploader" {
  project      = var.project_id
  account_id   = "ai-trading-desk-upload"
  display_name = "Family Desk static upload (GitHub OIDC)"
}

resource "google_service_account_iam_member" "desk_static_uploader_wif_binding" {
  service_account_id = google_service_account.desk_static_uploader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.deploy.name}/attribute.repository/${var.github_repository}"
}

resource "google_storage_bucket_iam_member" "desk_static_uploader_write" {
  bucket = google_storage_bucket.desk_static.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.desk_static_uploader.email}"
}

output "desk_bucket_name" {
  value       = google_storage_bucket.desk_static.name
  description = "Desk shell bucket, derived identically from the configured GCP project in Terraform, the upload workflow and the Worker. No repository bucket variable."
}

output "desk_static_uploader_email" {
  value       = google_service_account.desk_static_uploader.email
  description = "Dedicated Desk uploader identity, trusted by the existing main-only production deploy WIF provider."
}
