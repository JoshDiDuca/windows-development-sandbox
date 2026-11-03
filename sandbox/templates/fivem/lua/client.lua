-- {{name}}, client side: the /{{name}} command asks the server to say hello.
RegisterCommand('{{name}}', function()
  TriggerServerEvent('{{name}}:hello')
end, false)

RegisterNetEvent('{{name}}:reply', function(message)
  print(message)
end)
