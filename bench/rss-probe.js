// Preloaded with --import by the memory benchmark; reports the peak resident
// set size of the process on its last line of stderr.
process.on('exit', () => {
  process.stderr.write(`\n${JSON.stringify({ maxRss: process.resourceUsage().maxRSS * 1024 })}\n`);
});
