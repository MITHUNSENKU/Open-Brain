@echo off
cd /d "%~dp0"
echo Installing Open Brain...

echo 1/4 Installing root dependencies...
call npm install

echo 2/4 Installing backend dependencies...
cd backend
call npm install
cd ..

echo 3/4 Installing MCP server dependencies...
cd mcp-server
call npm install
cd ..

echo 4/4 Activating global command...
call npm install -g .

echo Installation complete! You can now start the agent from anywhere by typing: openbrain
pause
