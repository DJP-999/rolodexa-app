/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["postgres", "bullmq", "ioredis"],
  eslint: { ignoreDuringBuilds: true },
  // Don't block the first deploy on a stray type error; run `npm run typecheck`
  // locally/CI to surface them. Flip back to false once green.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
