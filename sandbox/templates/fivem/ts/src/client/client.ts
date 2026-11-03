// {{name}}, client side: the /{{name}} command asks the server to say hello.
RegisterCommand(
  '{{name}}',
  () => {
    emitNet('{{name}}:hello');
  },
  false,
);

onNet('{{name}}:reply', (message: string) => {
  console.log(message);
});
