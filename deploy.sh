#!/bin/bash
set -e

echo "🚀 Deploying AWS Bedrock Access Gateway with SAM..."
echo ""

# Check if SAM is installed
if ! command -v sam &> /dev/null; then
    echo "❌ AWS SAM CLI is not installed"
    echo "Install it from: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials are not configured"
    echo "Run: aws configure"
    exit 1
fi

# Check if samconfig.toml exists, if not create from example
if [ ! -f "samconfig.toml" ]; then
    if [ ! -f "samconfig.toml.example" ]; then
        echo "❌ samconfig.toml.example not found"
        exit 1
    fi
    echo "📋 Creating samconfig.toml from samconfig.toml.example..."
    cp samconfig.toml.example samconfig.toml

    echo ""
    echo "🔑 Configuration Setup"
    echo ""

    # API Key (required)
    read -p "API Key: " api_key
    if [ -z "$api_key" ]; then
        echo "❌ API key cannot be empty"
        exit 1
    fi

    # Default Model (pre-selected)
    read -p "Default Model [global.anthropic.claude-opus-4-6-v1]: " default_model
    default_model=${default_model:-global.anthropic.claude-opus-4-6-v1}

    # Default Embedding Model (pre-selected)
    read -p "Default Embedding Model [cohere.embed-multilingual-v3]: " default_embedding
    default_embedding=${default_embedding:-cohere.embed-multilingual-v3}

    # Apply configuration to samconfig.toml (using perl for safe literal replacement)
    DEPLOY_API_KEY="$api_key" DEPLOY_MODEL="$default_model" DEPLOY_EMBED="$default_embedding" \
    perl -i -pe '
        BEGIN {
            $key = $ENV{"DEPLOY_API_KEY"};
            $model = $ENV{"DEPLOY_MODEL"};
            $embed = $ENV{"DEPLOY_EMBED"};
        }
        if (/YOUR_API_KEY_HERE/) {
            $i = index($_, "YOUR_API_KEY_HERE");
            substr($_, $i, length("YOUR_API_KEY_HERE")) = $key;
        }
        if (/DefaultModelId=global\.anthropic\.claude-opus-4-6-v1/) {
            $i = index($_, "DefaultModelId=global.anthropic.claude-opus-4-6-v1");
            substr($_, $i, length("DefaultModelId=global.anthropic.claude-opus-4-6-v1")) = "DefaultModelId=" . $model;
        }
        if (/DefaultEmbeddingModel=cohere\.embed-multilingual-v3/) {
            $i = index($_, "DefaultEmbeddingModel=cohere.embed-multilingual-v3");
            substr($_, $i, length("DefaultEmbeddingModel=cohere.embed-multilingual-v3")) = "DefaultEmbeddingModel=" . $embed;
        }
    ' samconfig.toml

    echo ""
    echo "✅ Configuration complete"
    echo "   Model: $default_model"
    echo "   Embedding: $default_embedding"
    echo ""
fi

# Install dependencies
echo "📦 Installing dependencies..."
(cd src && npm ci)

# Build
echo "🔨 Building application..."
sam build

# Deploy
echo "🚀 Deploying to AWS..."
sam deploy --no-confirm-changeset

# Get outputs
echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Stack Outputs:"
aws cloudformation describe-stacks \
  --stack-name aws-bedrock-access-gateway \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output table

echo ""
echo "🧪 Ready-to-use test commands:"
echo ""

# Get the test commands from CloudFormation outputs (they already have the API key included)
MODELS_TEST=$(aws cloudformation describe-stacks \
  --stack-name aws-bedrock-access-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`ModelsTestCommand`].OutputValue' \
  --output text)

OPENAI_TEST=$(aws cloudformation describe-stacks \
  --stack-name aws-bedrock-access-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`OpenAITestCommand`].OutputValue' \
  --output text)

ANTHROPIC_TEST=$(aws cloudformation describe-stacks \
  --stack-name aws-bedrock-access-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`AnthropicTestCommand`].OutputValue' \
  --output text)

echo "📋 List available models:"
echo "$MODELS_TEST"
echo ""
echo "💬 Test OpenAI chat completion:"
echo "$OPENAI_TEST"
echo ""
echo "🤖 Test Anthropic messages:"
echo "$ANTHROPIC_TEST"
echo ""

# Run one quick test to verify deployment
echo "🔍 Running quick health check..."
API_URL=$(aws cloudformation describe-stacks \
  --stack-name aws-bedrock-access-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
  --output text)

HEALTH_RESPONSE=$(curl -s "$API_URL/health")
if echo "$HEALTH_RESPONSE" | grep -q "OK"; then
    echo "✅ API is healthy and ready to use!"
else
    echo "⚠️  Health check failed. Check the API Gateway and Lambda function."
fi
