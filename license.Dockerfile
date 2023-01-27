
FROM unityci/editor:2021.3.14f1-webgl-1

ARG UNITY_EMAIL=nobody@nowhere.com
ARG UNITY_PASSWORD=test

RUN $UNITY_PATH/Editor/Unity -batchmode -nographics -manualActivation -logFile /dev/stdout -username $UNITY_EMAIL -password $UNITY_PASSWORD

