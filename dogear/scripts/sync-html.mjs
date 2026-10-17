import {mkdir,copyFile} from 'node:fs/promises';
await mkdir(new URL('../web/',import.meta.url),{recursive:true});
await copyFile(new URL('../public/index.html',import.meta.url),new URL('../web/index.html',import.meta.url));
