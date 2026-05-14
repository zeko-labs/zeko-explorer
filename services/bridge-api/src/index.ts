import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4102);

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      component: "bridge-api",
      status: "ok",
      graph: "bridge",
    }),
  );
}).listen(port, () => {
  console.log(`bridge-api listening on ${port}`);
});
