#!/usr/bin/env bash
# Checks that the dev, staging and prod roots stay isolated and consistent with each other.
# Offline and credential-free: it reads the Terraform files only. Run from the repository root.
set -euo pipefail

fail() { echo "::error::$*"; status=1; }
status=0
envs=(dev staging prod)

for env in "${envs[@]}"; do
  dir="infra/envs/${env}"

  # Each environment keeps its state under its own prefix.
  grep -Eq "^\s*prefix\s*=\s*\"melonoffice/${env}\"" "${dir}/versions.tf" \
    || fail "${dir}: backend prefix must be melonoffice/${env}"

  # The environment and the GitHub environment its deployer trusts are its own.
  grep -Eq "^\s*environment\s*=\s*\"${env}\"" "${dir}/main.tf" \
    || fail "${dir}: environment must be \"${env}\""
  grep -Eq "^\s*github_environment\s*=\s*\"${env}\"" "${dir}/main.tf" \
    || fail "${dir}: github_environment must be \"${env}\""

  # No quoted name of another environment anywhere in this root.
  for other in "${envs[@]}"; do
    [ "$other" = "$env" ] && continue
    if grep -RIn --include='*.tf' --include='*.tfvars.example' "\"${other}\"\|melonoffice/${other}" "$dir"; then
      fail "${dir}: refers to the ${other} environment"
    fi
  done

  # Real identifiers live only in terraform.tfvars, which Git ignores.
  if grep -Ev '^\s*(#|$)' "${dir}/terraform.tfvars.example" | grep -E '^\s*(project_id|region|terraform_state_bucket)\s*=' | grep -Evq '"<[^>]+>"'; then
    fail "${dir}/terraform.tfvars.example: project_id, region and bucket must stay placeholders"
  fi
done

# Only dev deploys services and has Firestore and Identity Platform; staging and prod are protected
# from deletion.
grep -Eq '^\s*deploy_apps\s*=\s*true' infra/envs/dev/main.tf || fail "dev must deploy the apps"
for env in staging prod; do
  grep -Eq '^\s*deploy_apps\s*=\s*false' "infra/envs/${env}/main.tf" || fail "${env} must not deploy apps"
  grep -Eq '^\s*deletion_protection\s*=\s*true' "infra/envs/${env}/main.tf" || fail "${env} must keep deletion protection"
  if grep -Eq '^\s*firestore_and_auth\s*=\s*true' "infra/envs/${env}/main.tf"; then
    fail "${env} must not enable Firestore and Identity Platform yet (dev only)"
  fi
  if grep -Eq '^\s*(conversation_agents|whatsapp_channel)\s*=\s*true' "infra/envs/${env}/main.tf"; then
    fail "${env} must not run conversation agents or the WhatsApp channel yet (dev only)"
  fi
done

# No real variable files are committed.
if git ls-files 'infra/**/*.tfvars' | grep -q .; then
  fail "a terraform.tfvars file is committed"
fi

[ "$status" = 0 ] && echo "dev, staging and prod are isolated and consistent."
exit "$status"
