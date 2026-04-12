@echo off
echo Installing Open Brain...

echo 1/3 Installing root dependencies...
call npm install

echo 2/3 Installing backend dependencies...
cd backend
call npm install
cd ..

echo 3/3 Installing MCP server dependencies...
cd mcp-server
call npm install
cd ..

echo Installation complete! You can now start the Open Brain server and CLI.
