import vinext from 'vinext';
import {defineConfig} from 'vite';
import {sites} from './build/sites-vite-plugin';
export default defineConfig(async()=>{
 process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false';
 process.env.WRANGLER_SEND_METRICS ??= 'false';
 process.env.WRANGLER_WRITE_LOGS ??= 'false';
 process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
 process.env.WRANGLER_REGISTRY_PATH ??= '.wrangler/dev-registry';
 process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
 const {cloudflare}=await import('@cloudflare/vite-plugin');
 return {plugins:[vinext(),sites({mockAuth:true}),cloudflare({viteEnvironment:{name:'rsc',childEnvironments:['ssr']},inspectorPort:false,config:{main:'./build/sites-worker.ts',compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],d1_databases:[{binding:'DB',database_name:'dogear-d1',database_id:'00000000-0000-4000-8000-000000000000',migrations_dir:'drizzle'}]}})]};
});
