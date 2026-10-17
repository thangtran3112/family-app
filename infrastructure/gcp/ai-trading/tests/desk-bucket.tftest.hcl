mock_provider "google" {}

variables {
  mirofish_static_bucket_name = "offline-mirofish"
}

run "default_project_bucket" {
  command = plan
  assert {
    condition     = google_storage_bucket.desk_static.name == "tobytran-portfolio-ai-trading-desk"
    error_message = "Desk bucket must use the same project-derived name as the upload workflow and Worker."
  }
}

run "configured_project_bucket" {
  command = plan
  variables {
    project_id = "offline-project"
  }
  assert {
    condition     = google_storage_bucket.desk_static.name == "offline-project-ai-trading-desk"
    error_message = "Changing project must derive the bucket, not require a repository setting."
  }
  assert {
    condition     = google_storage_bucket_iam_member.desk_static_uploader_write.bucket == "offline-project-ai-trading-desk"
    error_message = "Uploader grant must remain scoped to the project-derived Desk bucket."
  }
}
