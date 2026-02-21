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

    # Serper API Key (optional, for web search)
    echo ""
    echo "🔍 Web Search (optional)"
    echo "   Get a free API key at https://serper.dev"
    read -p "Serper API Key (press Enter to skip): " serper_key
    serper_key=${serper_key:-}

    # Apply configuration to samconfig.toml (using perl for safe literal replacement)
    DEPLOY_API_KEY="$api_key" DEPLOY_MODEL="$default_model" DEPLOY_EMBED="$default_embedding" DEPLOY_SERPER="$serper_key" \
    perl -i -pe '
        BEGIN {
            $key = $ENV{"DEPLOY_API_KEY"};
            $model = $ENV{"DEPLOY_MODEL"};
            $embed = $ENV{"DEPLOY_EMBED"};
            $serper = $ENV{"DEPLOY_SERPER"};
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
        if (/SerperApiKey=/) {
            $i = index($_, "SerperApiKey=");
            # Replace from SerperApiKey= to the closing quote
            $end = index($_, "\"", $i);
            substr($_, $i, $end - $i) = "SerperApiKey=" . $serper;
        }
    ' samconfig.toml

    echo ""
    echo "✅ Configuration complete"
    echo "   Model: $default_model"
    echo "   Embedding: $default_embedding"
    if [ -n "$serper_key" ]; then
        echo "   Web Search: ✅ enabled (Serper.dev)"
    else
        echo "   Web Search: ⏭  skipped (set SerperApiKey later to enable)"
    fi
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
