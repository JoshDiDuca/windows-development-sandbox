// {{name}}, client side: the /{{name}} command asks the server to say hello.
RegisterCommand(
  '{{name}}',
  () => {
    emitNet('{{name}}:hello');
  },
  false,
);

onNet('{{name}}:reply', (message) => {
  console.log(message);
});
