// {{name}}, server side: answers the client's hello.
onNet('{{name}}:hello', () => {
  const player = String(source);
  console.log(GetPlayerName(player) + ' said hello');
  emitNet('{{name}}:reply', player, 'Hello from the server');
});
