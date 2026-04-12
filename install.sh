#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || exit

echo "Installing Open Brain..."

echo "1/3 Installing root dependencies..."
npm install

echo "2/3 Installing backend dependencies..."
cd backend || exit
npm install
cd ..

echo "3/3 Installing MCP server dependencies..."
cd mcp-server || exit
npm install
cd ..

echo "4/4 Activating global command..."
sudo npm link --force

echo "Installation complete! You can now start the agent from anywhere by typing: openbrain"
