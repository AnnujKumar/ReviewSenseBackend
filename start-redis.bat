@echo off
echo Starting Redis Server...
cd redis
start "" redis-server.exe
echo Redis is running in the background!
exit
