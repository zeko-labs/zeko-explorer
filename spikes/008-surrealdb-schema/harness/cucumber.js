export default {
  default: {
    paths: ["features/**/*.feature"],
    import: ["features/support/*.ts", "features/step_definitions/*.ts"],
    format: ["progress", "json:reports/cucumber-report.json"],
    publishQuiet: true
  }
};
