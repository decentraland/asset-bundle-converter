ARG UNITY_DOCKER_IMAGE=unityci/editor:2022.3.12f1-webgl-3.0.0

FROM node:18 AS builderenv

WORKDIR /consumer-server

# some packages require a build step
RUN apt-get update
RUN apt-get -y -qq install build-essential

# We use Tini to handle signals and PID1 (https://github.com/krallin/tini, read why here https://github.com/krallin/tini/issues/8)
ENV TINI_VERSION=v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

# install dependencies
COPY consumer-server/package.json /consumer-server/package.json
COPY consumer-server/yarn.lock /consumer-server/yarn.lock
RUN yarn --frozen-lockfile

# Make commit hash available to application
ARG COMMIT_HASH="Unknown"
RUN echo "COMMIT_HASH=$COMMIT_HASH" >> /consumer-server/.env
ARG VERSION_TAG="No version"
RUN echo "VERSION_TAG=$VERSION_TAG" >> /consumer-server/.env

# build the consumer-server
COPY consumer-server /consumer-server
RUN yarn build
RUN yarn test

# remove devDependencies, keep only used dependencies
RUN yarn --prod --frozen-lockfile

########################## END OF BUILD STAGE ##########################

FROM $UNITY_DOCKER_IMAGE

RUN apt-get update -y && \
    apt-get upgrade -y && \
    apt-get -y install xvfb \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=v18.20.4

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
RUN /bin/bash -c "source $NVM_DIR/nvm.sh && nvm install $NODE_VERSION && nvm use --delete-prefix $NODE_VERSION"

ENV NODE_PATH=$NVM_DIR/versions/node/$NODE_VERSION/lib/node_modules
ENV PATH=$NVM_DIR/versions/node/$NODE_VERSION/bin:$PATH

# Change this value ONLY if we have done breaking changes for every material, doing so is VERY costly
ENV AB_VERSION=v13
ENV AB_VERSION_WINDOWS=v27
ENV AB_VERSION_MAC=v27

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV=production
ENV PROJECT_PATH=/asset-bundle-converter

ARG PLATFORM_TARGET=webgl
ENV BUILD_TARGET=$PLATFORM_TARGET
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /consumer-server

# Create unity cache
RUN mkdir -p /root/.cache/unity3d && mkdir -p /root/.local/share/unity3d/Unity/

COPY /asset-bundle-converter /asset-bundle-converter
COPY --from=builderenv /consumer-server /consumer-server
COPY --from=builderenv /tini /tini

# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["/tini", "-g", "--", "xvfb-run", "--auto-servernum", "--error-file", "/dev/stdout" ]

# Run the program under Tini+xvfb
CMD [ "node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]
