// Preloaded with --import in tests: this process's clock runs AIM_TEST_CLOCK_SKEW_MS ahead (or behind).
const skew = Number(process.env.AIM_TEST_CLOCK_SKEW_MS || 0);
const real = Date.now.bind(Date);
Date.now = () => real() + skew;
