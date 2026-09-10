/**
 * Set the deployment's configuration, as a side effect of being imported.
 *
 * Lives beside netlify/functions/ rather than inside it: Netlify treats every
 * top-level file in the functions directory as a function of its own, and this
 * one was being deployed as an endpoint that does nothing.
 *
 * src/config.js resolves DEMO_MODE, BASE_PATH, NODE_ENV and the project root
 * once at import
 * time, and ES imports all evaluate before any statement in the importing
 * module runs -- so assigning them in app.mjs's body would happen after
 * config.js had already read them. Importing this module first is what makes
 * the ordering work. Same trick, and same reason, as test/demomode.js.
 *
 * (Top-level await would also order it, and was the first attempt. Netlify's
 * esbuild bundler emitted CJS for this function and rejected it outright:
 * "Top-level await is currently not supported with the cjs output format".)
 *
 * DEMO_MODE is asserted, not defaulted. This function *is* the public demo; a
 * deploy of it running with demo mode off would be an unauthenticated invoice
 * editor trying to write to a read-only filesystem. That is a bug, not a
 * setting, so it is not left to an environment variable.
 *
 * These live here rather than in netlify.toml's [build.environment] because
 * those are build-time only -- a function reading them at runtime gets
 * nothing.
 */
// Bundling flattens the app into one directory and strips `import.meta`, so
// src/config.js cannot work out where its own templates are. In Lambda the
// bundle is unpacked at LAMBDA_TASK_ROOT, which is exactly that directory.
process.env.INVOISAURUS_ROOT ??= process.env.LAMBDA_TASK_ROOT || process.cwd();

process.env.DEMO_MODE = 'true';

// BASE_PATH is deliberately not defaulted here. It describes where a
// particular deployment is mounted, not anything about this app, and baking
// one site's path into the repo would serve every fork under a prefix that
// means nothing on its host. Unset means the root, which is what a fork wants.
// This project's own deploy sets it as a project environment variable.

// Turns on template caching in src/viewEngine.js. Deliberately not set in
// netlify.toml: NODE_ENV=production at build time makes npm skip
// devDependencies, and @tailwindcss/cli is one, so the stylesheet would
// silently never be built.
process.env.NODE_ENV ??= 'production';
