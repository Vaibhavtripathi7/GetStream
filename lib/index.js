

let config = {
    url : "https://www.cricbuzz.com",
    method: "POST",
    headers: {"Content-Type": "Application/json"},
    body: JSON.stringify({"hello": "world"}) 
}

async function executeRequest(config){

    const start = performance.now()
    const response = await fetch(config.url, {method:config.method, headers:config.headers, body:config.body}); // request method
    const end = performance.now();

    const timetaken = Math.round(end - start);

    return{
        status: response.status,
        headers: response.headers,
        body: response.body,
        time: timetaken
    }
};

executeRequest(config).then(console.log)

module.exports = { executeRequest };