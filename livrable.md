# Livrableq


## Test “Hello world” :
~ docker run hello-world
Unable to find image 'hello-world:latest' locally
latest: Pulling from library/hello-world
58dee6a49ef1: Pull complete 
Digest: sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8
Status: Downloaded newer image for hello-world:latest

Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
    (arm64v8)
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client, which sent it
    to your terminal.

To try something more ambitious, you can run an Ubuntu container with:
 $ docker run -it ubuntu bash

Share images, automate workflows, and more with a free Docker ID:
 https://hub.docker.com/

For more examples and ideas, visit:
 https://docs.docker.com/get-started/


## Docker ps (après avoir stoppé le web1)
➜  tp-docker-image git:(main) ✗ docker ps                            
CONTAINER ID   IMAGE                COMMAND                  CREATED          STATUS          PORTS                                                    NAMES
cdaf2786b3cc   mysql:8              "docker-entrypoint.s…"   19 minutes ago   Up 19 minutes   33060/tcp, 0.0.0.0:3307->3306/tcp, [::]:3307->3306/tcp   mysql2
071e756d3e08   mysql:8              "docker-entrypoint.s…"   20 minutes ago   Up 20 minutes   0.0.0.0:3306->3306/tcp, :::3306->3306/tcp, 33060/tcp     mysql1
72f831d31fc9   nginx:alpine         "/docker-entrypoint.…"   25 minutes ago   Up 23 minutes   0.0.0.0:8080->80/tcp, [::]:8080->80/tcp                  web1
7df433100276   postgres:16-alpine   "docker-entrypoint.s…"   3 weeks ago      Up 27 minutes   0.0.0.0:5432->5432/tcp, :::5432->5432/tcp                restaurant_db

## docker build -t monsite:1.0 .
tp-docker-image git:(main) ✗ docker build -t monsite:1.0 .
[+] Building 0.3s (7/7) FINISHED                                                                                                          docker:orbstack
 => [internal] load build definition from Dockerfile                                                                                                 0.0s
 => => transferring dockerfile: 103B                                                                                                                 0.0s
 => [internal] load metadata for docker.io/library/nginx:alpine                                                                                      0.0s
 => [internal] load .dockerignore                                                                                                                    0.0s
 => => transferring context: 2B                                                                                                                      0.0s
 => [internal] load build context                                                                                                                    0.1s
 => => transferring context: 245B                                                                                                                    0.0s
 => [1/2] FROM docker.io/library/nginx:alpine                                                                                                        0.1s
 => [2/2] COPY index.html /usr/share/nginx/html/index.html                                                                                           0.0s
 => exporting to image                                                                                                                               0.0s
 => => exporting layers                                                                                                                              0.0s
 => => writing image sha256:2e566b38c2794fc780e8f493ad893ef3e05bc669295d09d748bb04de37ab6231                                                         0.0s
 => => naming to docker.io/library/monsite:1.0    

 ## docker run ... monsite:1.0
 tp-docker-image git:(main) ✗ docker run --name monsite1 -p 8081:80 -d monsite:1.0
9b00e3a49701187a51b1e8580b979960ff6b15a0ad19096c3499e3149394b469

## docker push
tp-docker-image git:(main) ✗ docker push camille386/monsite:1.0
The push refers to repository [docker.io/camille386/monsite]
21799a6f9a1c: Pushed 
85540c9907c3: Mounted from library/nginx 
f3ced1badaf7: Mounted from library/nginx 
966ef53a3939: Mounted from library/nginx 
d115badb4753: Mounted from library/nginx 
083503863067: Mounted from library/nginx 
58bc6899720f: Mounted from library/nginx 
f1c509e8c93b: Mounted from library/nginx 
1b349a333453: Mounted from library/nginx 
1.0: digest: sha256:25190dd99cb08890c78a7bdfe4403e9cfcab99c2b06b34f6586355d660c0eaa8 size: 2196


## Questions de validation (à rendre)

1. Quelle différence entre **image** et **conteneur** ?
    une image c'est un modèle figé qui contient des informations comme le code, la config et les dépendances alors qu'un conteneur c'est une instance isolée d'une image
2. À quoi sert `-p 8081:80` ? Dans quel sens va le mapping ?
    ça redirige le trafic réseau depuis le port hôte vers le port conteneur (8081 vers 80)
3. Différence entre `docker run` et `docker start` ?
    docker run : crée et démarre un nouveau conteneur à partir d'une image
    docker start : Redémarre un conteneur qui existe déjà

4. Quelle commande donne la configuration complète d’un conteneur ?
    docker inspect <nom_ou_id_conteneur>

5. Pourquoi tagger une image avant un `docker push` ?
    Pour que Docker Hub identifie le compte lors de l'envoi