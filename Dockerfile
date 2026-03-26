FROM nginx:alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY proptrex_tbx.html /usr/share/nginx/html/index.html
EXPOSE 3020
