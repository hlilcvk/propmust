FROM nginx:alpine
COPY proptrex_tbx.html /usr/share/nginx/html/index.html
EXPOSE 3020
