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
fi

# Check if API key is set in samconfig.toml
if grep -q "YOUR_API_KEY_HERE" samconfig.toml; then
    echo ""
    echo "🔑 API Key Setup Required"
    echo "Please enter your API key for authentication:"
    read -p "API Key: " api_key
    
    if [ -z "$api_key" ]; then
        echo "❌ API key cannot be empty"
        exit 1
    fi
    
    # Replace the placeholder with the actual API key
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/YOUR_API_KEY_HERE/$api_key/g" samconfig.toml
    else
        # Linux
        sed -i "s/YOUR_API_KEY_HERE/$api_key/g" samconfig.toml
    fi
    
    echo "✅ API key configured successfully"
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
