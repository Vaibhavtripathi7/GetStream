#!/usr/bin/env node

const { parseArgs } = require('node:util');
const { executeRequest } = require('../lib/index.js')

const options = {
    url : {type: 'string', short: 'u'},
    method: { type: 'string', short: 'm', default: 'GET'},
    body: { type: 'string', short: 'b'},
    header: { type: 'string', short: 'H', multiple: true}
};

function parseHeaders(headerArray) {
    if(!headerArray) { return undefined};

    const headerObj = {};
    for (const h of headerArray){
        const splitIndex = h.indexOf(':');
        if (splitIndex == -1 ){ continue}
        const key = h.slice(0, splitIndex).trim();
        const value = h.slice(splitIndex + 1).trim();
        headerObj[key] = value;
    }
    return headerObj;
}


async function main() {
    
    try {
        const {values} = parseArgs({options})
        if (!values.url) {
            console.error('\x1b[31mError:\x1b[0m URL is required. Use -u <url>');
            process.exit(1);
        }
        const config = {
            url: values.url,
            method: values.method,
            body: values.body
    }
        const response = await executeRequest(config);
        console.log(`${response.status}`)
        
        if(!response.body){
            process.exit(0);
        }
        for await (const chunk of response.body){
            process.stdout.write(chunk);
        }
        console.log();

    }catch(error){
        console.error(`${error.message}`);
        process.exit(1);
    }
}

main();