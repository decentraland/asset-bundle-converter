ARG RUN


FROM node:18 as builderenv

WORKDIR /consumer-server

# some packages require a build step
RUN apt-get update
RUN apt-get -y -qq install python-setuptools python-dev build-essential

# We use Tini to handle signals and PID1 (https://github.com/krallin/tini, read why here https://github.com/krallin/tini/issues/8)
ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

# install dependencies
COPY consumer-server/package.json /consumer-server/package.json
COPY consumer-server/package-lock.json /consumer-server/package-lock.json
RUN npm ci

# build the consumer-server
COPY consumer-server /consumer-server
RUN npm run build
RUN npm run test

# remove devDependencies, keep only used dependencies
RUN npm ci --only=production

########################## END OF BUILD STAGE ##########################

FROM unityci/editor:2021.3.14f1-webgl-1

ENV NVM_DIR /root/.nvm
ENV NODE_VERSION v16.18.0

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.2/install.sh | bash
RUN /bin/bash -c "source $NVM_DIR/nvm.sh && nvm install $NODE_VERSION && nvm use --delete-prefix $NODE_VERSION"

ENV NODE_PATH $NVM_DIR/versions/node/$NODE_VERSION/lib/node_modules
ENV PATH $NVM_DIR/versions/node/$NODE_VERSION/bin:$PATH

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV production
ENV PROJECT_PATH /asset-bundle-converter
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /consumer-server

# Create unity cache
RUN mkdir -p /root/.cache/unity3d && mkdir -p /root/.local/share/unity3d/Unity/

COPY /asset-bundle-converter /asset-bundle-converter
COPY --from=builderenv /consumer-server /consumer-server
COPY --from=builderenv /tini /tini

# test the integration of server + conversor
COPY Unity_lic.ulf /root/.local/share/unity3d/Unity/Unity_lic.ulf

RUN xvfb-run --auto-servernum --server-args='-screen 0 640x480x24' \
    node --trace-warnings --abort-on-uncaught-exception --unhandled-rejections=strict dist/test-conversion.js \
      --baseUrl https://peer.decentraland.org/content \
      --pointer urn:decentraland:off-chain:base-avatars:brown_pants \
      --outDir /tmp-ab \
      --logFile /tmp-ab/log.txt && cat /tmp-ab/log.txt && rm -rf /tmp-ab

# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["/tini", "--"]
# Run the program under Tini
CMD [ "xvfb-run", "--auto-servernum", "--server-args='-screen 0 640x480x24'", "node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]
