import { createRuntimeServer, LOOPBACK_ADDRESS, requireLoopbackAddress } from './server.js';

const requestedAddress = process.env.IRIS_BIND_ADDRESS ?? LOOPBACK_ADDRESS;
const address = requireLoopbackAddress(requestedAddress);
const configuredPort = process.env.IRIS_PORT;
const port = configuredPort === undefined ? 0 : Number(configuredPort);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('IRIS_PORT must be an integer from 0 through 65535');
}

const server = createRuntimeServer();
server.listen(port, address, () => {
  const bound = server.address();
  if (typeof bound !== 'object' || bound === null) throw new Error('Runtime listener address unavailable');
  console.log(`IRIS runtime listening at http://${address}:${bound.port}`);
});
