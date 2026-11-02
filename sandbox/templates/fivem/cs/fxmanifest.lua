fx_version 'cerulean'
{{gameLines}}

name '{{name}}'
description 'Made with sbx-fivem new (C#: dotnet publish -c Release in Client and Server)'
version '0.1.0'

file 'Client/bin/Release/**/publish/*.dll'

client_script 'Client/bin/Release/**/publish/*.net.dll'
server_script 'Server/bin/Release/**/publish/*.net.dll'
