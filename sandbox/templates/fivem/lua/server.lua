-- {{name}}, server side: answers the client's hello.
RegisterNetEvent('{{name}}:hello', function()
  local player = source
  print(('%s said hello'):format(GetPlayerName(player)))
  TriggerClientEvent('{{name}}:reply', player, 'Hello from the server')
end)
