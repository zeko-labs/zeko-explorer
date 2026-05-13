import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4101);

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      component: "explorer-api",
      status: "ok",
      graph: "explorer",
    }),
  );
}).listen(port, () => {
  console.log(`explorer-api listening on ${port}`);
});
