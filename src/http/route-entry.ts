import { handleRequest } from './router';

function entry(request: Request): Promise<Response> {
  return handleRequest(request);
}

export { entry as GET, entry as POST, entry as DELETE, entry as HEAD, entry as OPTIONS };
