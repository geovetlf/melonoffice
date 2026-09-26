variable "project_id" {
  description = "Google Cloud project ID the budget watches."
  type        = string
}

variable "billing_account_id" {
  description = "Billing account that owns the budget, in the form XXXXXX-XXXXXX-XXXXXX."
  type        = string
}

variable "display_name" {
  description = "Budget name shown in the billing console."
  type        = string
}

variable "monthly_amount" {
  description = "Monthly budget in whole currency units."
  type        = number

  validation {
    condition     = var.monthly_amount > 0 && floor(var.monthly_amount) == var.monthly_amount
    error_message = "monthly_amount must be a positive whole number."
  }
}

variable "currency_code" {
  description = "ISO 4217 code. It must match the billing account currency."
  type        = string
}

variable "thresholds" {
  description = "Fractions of the budget that trigger an alert."
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}

variable "alert_emails" {
  description = "Extra email recipients, in addition to the billing account administrators."
  type        = list(string)
  default     = []
}
