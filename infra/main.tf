provider "aws" {
  region = var.aws_region
}

# ─── Variables ──────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-central-1"
}

variable "function_name" {
  description = "Lambda function name"
  type        = string
  default     = "gitlab-copilot-reviewer"
}

variable "gitlab_url" {
  description = "GitLab instance URL"
  type        = string
}

variable "gitlab_token" {
  description = "GitLab API access token"
  type        = string
  sensitive   = true
}

variable "gitlab_bot_username" {
  description = "GitLab service account username that triggers reviews"
  type        = string
}

variable "gitlab_webhook_secret" {
  description = "GitLab webhook secret token (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_token" {
  description = "GitHub PAT with Copilot access"
  type        = string
  sensitive   = true
}

variable "copilot_model" {
  description = "Copilot model to use"
  type        = string
  default     = "gpt-4.1"
}

variable "copilot_cli_layer_arn" {
  description = "ARN of a pre-existing Copilot SDK Lambda layer. Leave empty to build automatically via Docker."
  type        = string
  default     = ""
}

variable "git_layer_arn" {
  description = "ARN of a pre-existing Git Lambda layer. Leave empty to build automatically via Docker."
  type        = string
  default     = ""
}

# ─── Lambda Layers (built from Docker) ──────────────────────────────────────

resource "null_resource" "build_git_layer" {
  count = var.git_layer_arn == "" ? 1 : 0

  triggers = {
    script_hash = filesha256("${path.module}/scripts/build-git-layer.sh")
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/scripts/build-git-layer.sh ${path.module}/layers"
  }
}

resource "null_resource" "build_copilot_layer" {
  count = var.copilot_cli_layer_arn == "" ? 1 : 0

  triggers = {
    script_hash = filesha256("${path.module}/scripts/build-copilot-layer.sh")
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/scripts/build-copilot-layer.sh ${path.module}/layers"
  }
}

resource "aws_lambda_layer_version" "git" {
  count = var.git_layer_arn == "" ? 1 : 0

  layer_name               = "${var.function_name}-git"
  filename                 = "${path.module}/layers/git-layer.zip"
  compatible_runtimes      = ["nodejs24.x"]
  compatible_architectures = ["x86_64"]
  description              = "Git for Amazon Linux 2023"

  depends_on = [null_resource.build_git_layer]
}

resource "aws_lambda_layer_version" "copilot_sdk" {
  count = var.copilot_cli_layer_arn == "" ? 1 : 0

  layer_name               = "${var.function_name}-copilot-sdk"
  filename                 = "${path.module}/layers/copilot-sdk-layer.zip"
  compatible_runtimes      = ["nodejs24.x"]
  compatible_architectures = ["x86_64"]
  description              = "GitHub Copilot SDK and CLI"

  depends_on = [null_resource.build_copilot_layer]
}

# ─── IAM Role ───────────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_role" {
  name = "${var.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ─── Lambda Function ────────────────────────────────────────────────────────

resource "aws_lambda_function" "reviewer" {
  function_name = var.function_name
  role          = aws_iam_role.lambda_role.arn
  runtime       = "nodejs24.x"
  handler       = "index.handler"
  filename      = "${path.module}/../lambda.zip"
  timeout       = 600 # 10 minutes – clone + review can take time
  memory_size   = 1024

  source_code_hash = filebase64sha256("${path.module}/../lambda.zip")

  ephemeral_storage {
    size = 2048 # 2 GB for git clone
  }

  environment {
    variables = {
      GITLAB_URL            = var.gitlab_url
      GITLAB_TOKEN          = var.gitlab_token
      GITLAB_BOT_USERNAME   = var.gitlab_bot_username
      GITLAB_WEBHOOK_SECRET = var.gitlab_webhook_secret
      GITHUB_TOKEN          = var.github_token
      COPILOT_MODEL         = var.copilot_model
      GIT_EXEC_PATH         = "/opt/libexec/git-core"
    }
  }

  # Lambda layers: built automatically or supplied via variables
  layers = compact([
    var.copilot_cli_layer_arn != "" ? var.copilot_cli_layer_arn : try(aws_lambda_layer_version.copilot_sdk[0].arn, ""),
    var.git_layer_arn != "" ? var.git_layer_arn : try(aws_lambda_layer_version.git[0].arn, ""),
  ])
}

# ─── Function URL ────────────────────────────────────────────────────────────

resource "aws_lambda_function_url" "reviewer_url" {
  function_name      = aws_lambda_function.reviewer.function_name
  authorization_type = "NONE" # Public – secured by webhook secret token
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "function_url" {
  description = "Lambda Function URL – use this as the GitLab webhook URL"
  value       = aws_lambda_function_url.reviewer_url.function_url
}

output "function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.reviewer.function_name
}
