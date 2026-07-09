@echo off
echo Stopping Redis Server...
cd redis
redis-cli.exe shutdown
echo Redis has been stopped!
exit
