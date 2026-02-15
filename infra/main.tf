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
    }
  }

  # Lambda layers:
  # 1. Copilot CLI binary (required – the SDK spawns it as a child process)
  # 2. Git binary (required – used to clone the repository)
  layers = compact([
    var.copilot_cli_layer_arn,
    var.git_layer_arn,
  ])
}

variable "copilot_cli_layer_arn" {
  description = "ARN of the Lambda layer containing the Copilot CLI binary"
  type        = string
  default     = ""
}

variable "git_layer_arn" {
  description = "ARN of the Lambda layer containing the git binary (e.g. lambci/git-lambda-layer)"
  type        = string
  default     = ""
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
