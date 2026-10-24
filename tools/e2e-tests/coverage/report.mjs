// Merges the V8 data every test added into one report under coverage-results/report/.
import MCR from "monocart-coverage-reports";
import options from "./mcr.config.mjs";

await MCR(options).generate();
