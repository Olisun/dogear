import {env} from 'cloudflare:workers';
import handleLibrary from '../../../server/library.js';
export function GET(request:Request){return handleLibrary(request,env,request.headers.get('oai-authenticated-user-id'));}
export function POST(request:Request){return handleLibrary(request,env,request.headers.get('oai-authenticated-user-id'));}
