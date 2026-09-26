terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.4"
    }
  }

  # Partial configuration. The bucket is passed at init time:
  #   terraform init -backend-config="bucket=<state bucket>"
  backend "gcs" {
    prefix = "melonoffice/prod"
  }
}
