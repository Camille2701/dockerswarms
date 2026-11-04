# Rendu QuickPoll

## Environnement de test

- Cluster Swarm de 3 nœuds : `manager1` (leader), `worker1`, `worker2`, Docker Engine 29.8.2.
- Les nœuds sont des conteneurs `docker:dind` sur une seule machine (OrbStack). Les résultats valident la configuration, mais ne simulent pas une vraie panne réseau entre plusieurs hôtes.
- Label `db=true` posé sur `worker2`.
- Sonde lancée depuis `manager1` sur `http://192.168.158.2:8080`.
- Les sorties brutes sont dans [`captures/`](captures/).

## Étape 1 — Cluster

Les 3 nœuds sont `Ready`, le registry est déployé et les images `quickpoll-front:v1`, `quickpoll-worker:v1` et `quickpoll-api:v1/v2/v3` y sont poussées.

### Question 1.1

Le port publié par un service Swarm passe par le routing mesh : chaque nœud écoute sur le port 5000 et redirige la requête vers une tâche du service, quel que soit le nœud qui l'héberge.

Observé pendant le TP : le registry tournait sur `worker1`, et `manager1` y poussait ses images via `127.0.0.1:5000`.

## Étape 2 — Les cinq problèmes

Les numéros de ligne renvoient au fichier d'origine, conservé sous [`stack 2.yml`](<stack 2.yml>). Il a d'abord été déployé tel quel. Comme l'erreur d'images bloquait tout, une copie temporaire a ensuite corrigé **uniquement** les images pour faire apparaître les quatre autres problèmes.

Captures : [`origine-deploiement.txt`](captures/origine-deploiement.txt), [`origine-variante.txt`](captures/origine-variante.txt), [`origine-risques.txt`](captures/origine-risques.txt).

### 1. Images locales et `build` — lignes 6-7, 16-17, 35-36

- **Symptôme observé :** `Ignoring unsupported options: build`, puis `0/1` sur `front`, `api` et `worker`, avec l'erreur :
  ```text
  pull access denied for quickpoll-api, repository does not exist or may require 'docker login'
  ```
- **Cause :** `docker stack deploy` ne construit pas d'image, et le nom `quickpoll-api:v1` désigne Docker Hub.
- **Correction :** retirer `build` et utiliser `${REGISTRY:-127.0.0.1:5000}/quickpoll-...`, que tous les nœuds peuvent atteindre.

### 2. Aucun redémarrage de l'API — ligne 32 (`depends_on` : lignes 12-13, 26-28, 45-47)

- **Symptôme observé :** quand Postgres a été replanifié, le processus de l'API a planté (`Failed`, `non-zero exit (1)`). Avec `condition: none`, il n'a jamais été relancé : `orig_api 0/1` et 502 sur `/api/version`.
- **Cause :** `condition: none` interdit tout redémarrage, et `depends_on` est ignoré par `docker stack deploy`.
- **Correction :** `restart_policy.condition: any`, healthcheck, et suppression de `depends_on`.
- **Remarque :** au démarrage, l'API a survécu à l'absence de Postgres uniquement grâce au retry du bonus (`init attempt 1/10 failed: getaddrinfo ENOTFOUND postgres`).

### 3. Mot de passe en clair — lignes 22, 41, 59

- **Symptôme observé :** le mot de passe apparaît dans le fichier, et donc dans Git, ainsi qu'en clair dans `docker service inspect orig_api`.
- **Correction :** secret externe `quickpoll_db_password` et variables `*_PASSWORD_FILE`. Vérifié : l'environnement de l'API ne contient plus que `DB_PASSWORD_FILE=/run/secrets/db_password`.

### 4. Postgres exposé publiquement — lignes 60-61

- **Symptôme observé :** à cause du routing mesh, le port 5432 répond sur **les 3 nœuds**, y compris ceux qui n'hébergent pas Postgres :
  ```text
  manager1:5432 -> OUVERT
  worker1:5432 -> OUVERT
  worker2:5432 -> OUVERT
  ```
  Combiné au problème 3, n'importe quel client réseau peut se connecter à la base.
- **Correction :** retirer `ports`. L'API et le worker joignent Postgres par le réseau overlay interne.

### 5. Postgres non épinglé, perte de données — lignes 54-65

- **Symptôme observé :** 3 votes ont été enregistrés, puis Postgres a été replanifié de `worker2` vers `worker1`. La base repart vide :
  ```text
  ERROR:  relation "votes" does not exist
  ```
  Les données restent sur l'ancien nœud (45,9 Mo dans `orig_pgdata` sur `worker2`), mais la nouvelle tâche ne les voit pas, car un volume `local` n'existe que sur son nœud.
- **Correction :** contrainte `node.labels.db == true`, pour que Postgres retrouve toujours son volume.

**Autres défauts corrigés à l'étape 3 :** un seul réseau pour tous les services (lignes 67-68) et une seule réplique d'API (ligne 30).

**Point de contrôle validé :** la page répond en HTTP 200 et les votes arrivent en base.

## Étape 3 — Stack production-ready

| Exigence | Résultat observé |
|---|---|
| Aucun secret en clair | Secret Docker externe, créé avec une valeur aléatoire |
| Postgres épinglé | Tâche sur `worker2`, le nœud `db=true`, sans port publié |
| Deux réseaux overlay | Depuis `front` : `api:3000` ouvert ; `redis` et `postgres` ne sont même pas résolus par le DNS |
| API | 3/3 réplicas, healthcheck sur `/api/health` via `node`, `restart_policy.condition: any` |
| Tags paramétrables | `${API_TAG:-v1}` et équivalents |

Le healthcheck renvoie 0 sur une réponse 200, et 1 sur une réponse 500 ou un port fermé.

**Pourquoi `any` et pas `on-failure` :** la première version utilisait `on-failure`, et l'API restait bloquée à `0/3` sans jamais repartir. Quand le healthcheck échoue, Swarm envoie `SIGTERM`, l'application s'arrête proprement avec le code 0 (`Complete`), et `on-failure` ne considère pas cela comme un échec. Avec `any`, l'API revient seule.

**Bonus :** retry avec backoff exponentiel dans `init` (`app/api/server.js`) : 10 tentatives, délai doublé à chaque essai, plafonné à 15 s.

Un bug de ce retry a été trouvé en test : si Redis était en retard, toutes les tentatives suivantes échouaient avec `Socket already opened`, car le client restait ouvert. Il est désormais fermé entre deux essais. Validé en démarrant l'API sans Redis : elle revient à 3/3 en 25 s environ après le retour de Redis ([capture](captures/test-redis-retard.txt)).

### Question 3.1

`depends_on` n'a aucun effet avec `docker stack deploy`. L'API tolère un Postgres absent grâce à deux mécanismes : le retry dans `init`, puis `restart_policy` si cela ne suffit pas.

Observé au premier déploiement, l'API a démarré avant Postgres :

```text
init attempt 3/10 failed: getaddrinfo ENOTFOUND postgres
init attempt 4/10 failed: connect ECONNREFUSED 10.0.2.2:5432
api v1 listening on 3000
```

Le worker, lui, n'a pas de retry : il a planté une fois (`getaddrinfo ENOTFOUND redis`), puis Swarm l'a redémarré.

La bonne réponse architecturale est qu'**un service ne doit jamais dépendre de l'ordre de démarrage**. Chacun doit supporter l'absence temporaire de ses dépendances, au démarrage comme en cours d'exécution, avec reconnexion, retry borné et timeouts.

## Étape 4 — Rolling update

Configuration de l'API : `parallelism: 1`, `order: start-first`, `failure_action: rollback`, `monitor: 40s`.

Le `monitor` a été passé de 15 s à 40 s par précaution : un conteneur cassé n'est déclaré `unhealthy` qu'après environ 35 s (`start_period` + 5 essais de 5 s). La valeur de 15 s n'a pas été testée.

### Passage v1 → v2 : `ko=0`

Extrait de la capture de la sonde, à l'arrivée du premier conteneur v2 :

```text
14:58:12  {"version":"v1","host":"33fc56ecc6bd"} 200  (ok=52 ko=0)
14:58:12  {"version":"v2","host":"c875d6cb85ba"} 200  (ok=53 ko=0)
14:58:13  {"version":"v2","host":"c875d6cb85ba"} 200  (ok=54 ko=0)
14:58:13  {"version":"v1","host":"e513aa915161"} 200  (ok=55 ko=0)
14:58:13  {"version":"v1","host":"e513aa915161"} 200  (ok=56 ko=0)
14:58:13  {"version":"v1","host":"92ec293703e4"} 200  (ok=57 ko=0)
```

Le premier v2 répond à 14:58:12, le dernier v1 à 14:58:33. Capture complète : [`captures/sonde-v1-v2.txt`](captures/sonde-v1-v2.txt) (363 requêtes, toutes en HTTP 200).

### Déploiement de la v3 cassée : rollback automatique

- `UpdateStatus.State` passe à `rollback_started` après 37 s environ, puis à `rollback_completed` après 83 s environ.
- Le service revient sur `quickpoll-api:v2`, à 3/3.
- La sonde n'a jamais reçu de réponse v3, car un conteneur qui n'est pas `healthy` ne reçoit pas de trafic.
- Bilan sur v1 → v2 → v3 → rollback : **`TOTAL ok=745 ko=0`** ([sortie complète](captures/sonde-v1-v2-v3-complete.txt)).

### Question 4.1

Avec `stop-first` et `replicas: 1`, Swarm arrête l'unique conteneur avant de démarrer le nouveau. Plus aucune API ne répond jusqu'à ce que le nouveau conteneur soit `healthy`, et la sonde compte des `ko`. Avec le healthcheck de cette stack, cela peut durer plusieurs secondes.

`start-first` évite cette coupure, à condition que le service supporte deux versions en parallèle et que le nœud ait la capacité d'héberger un conteneur de plus.

## Étape 5 — Chaos

### Drain de `worker1`

`worker1` a été choisi car c'était le nœud le plus chargé sans Postgres.

| Essai | Tâches sur `worker1` | Résultat de la sonde | Votes |
|---|---|---|---|
| `front` à 1 réplica | `front`, 1 `api`, registry | `ok=730 ko=10`, coupure d'environ 4 s | 14 avant, 14 après |
| `front` à 2 réplicas | 2 `api` sur 3, 1 `front`, `redis`, `worker` | `ok=710 ko=5`, coupure d'environ 5 s | 15 avant, 15 après |

Passer `front` à 2 réplicas supprime le point unique de panne de ce service, mais pas toute coupure. Lors d'un essai intermédiaire avec seulement 1 `api` et 1 `front` sur le nœud, la sonde n'a montré aucune erreur (`ok=754 ko=0`, sortie non conservée). Le second essai est plus défavorable : un drain arrête les tâches du nœud sans appliquer la logique `start-first`, et `worker1` portait alors 2 des 3 API.

Détails : [`drain-worker1.txt`](captures/drain-worker1.txt), [`retest-drain-front2.txt`](captures/retest-drain-front2.txt).

### Les tâches reviennent-elles d'elles-mêmes ?

**Non.** Après la remise en `active`, `worker1` reste à 0 tâche ([capture](captures/reactivation-worker1.txt)).

Swarm respecte l'état désiré (le bon nombre de réplicas) et ne déplace pas une tâche saine pour équilibrer la charge, car cela provoquerait des redémarrages inutiles. Le nœud ne reçoit que de nouvelles tâches.

Pour rééquilibrer, on force une mise à jour : `docker service update --force quickpoll_api`. Observé : 2 réplicas sont revenus sur `worker1`, et la répartition est passée de 2 + 0 + 6 à 2 + 2 + 4 tâches.

### Question 5.1

**Oui, pour un vote rejoué.** Le worker insère avec `ON CONFLICT (vote_id) DO NOTHING` et `vote_id` est `UNIQUE` : un même message rejoué ne compte qu'une fois.

Cette idempotence ne protège pourtant pas de tout :

- **Perte possible :** `BRPOP` retire le vote de Redis avant l'`INSERT`. Si le worker s'arrête entre les deux, le vote est perdu au lieu d'être rejoué. Il faudrait confirmer le traitement après l'écriture, par exemple avec `BLMOVE` et une liste de traitement en cours.
- **Doublon côté client :** `vote_id` est généré par l'API. Si un client renvoie sa requête, il obtient un nouvel identifiant et le vote compte deux fois.
- **Redis sans volume :** les votes encore en file sont perdus si Redis redémarre.

### Question 5.2

Observé 60 s après le drain de `worker2` ([capture](captures/drain-worker2-db.txt)) :

```text
quickpoll_api 0/3
quickpoll_front 2/2
quickpoll_postgres 0/1
quickpoll_redis 1/1
quickpoll_worker 1/1
postgres | Pending about a minute ago | "no suitable node (scheduling …"
```

La contrainte `db == true` n'est satisfaite par aucun autre nœud : Postgres reste `Pending`. La panne dépasse la base : la page statique répond toujours, mais `/api/version` renvoie 502 alors qu'il n'interroge pas Postgres. `/api/health` exécute `SELECT 1` et `init` exige Postgres : l'API tout entière dépend donc de la base.

Après la remise en `active`, tout est revenu seul en 10 s environ, avec Postgres sur `worker2`, son volume et les 15 votes intacts. Bilan de la sonde : `ok=52 ko=257`.

Swarm orchestre très bien les services sans état, mais il ne réplique pas les données et un volume `local` reste lié à son nœud. La haute disponibilité d'un service stateful demande autre chose : réplication Postgres, stockage distribué ou base managée. Il faut aussi planifier la maintenance du nœud `db=true`, qui reste un point unique de panne.

### Incidents observés pendant le test

- **Registry sans volume :** déployé comme dans le sujet, il perd toutes ses images dès qu'il change de nœud ou redémarre (`{"repositories":[]}`). Une tâche replanifiée peut alors échouer avec `failed to resolve reference ... not found`. En production, il faut un volume persistant et un placement fixe.
- **Gel de l'environnement :** lors d'un premier essai, la sonde et les logs du manager n'ont rien écrit pendant environ 5 minutes (14:36:27 → 14:41:40), puis les nœuds ont perdu leur session avec le manager (`node not registered`). La cause n'a pas été établie. Comme la sonde tournait dans le cluster, cela vient de l'environnement de test plutôt que de la stack. L'incident ne s'est pas reproduit lors de l'essai final.

## Commandes utiles

```sh
docker node update --label-add db=true worker2
docker service create --name registry --publish 5000:5000 registry:2
./scripts/build-and-push.sh
printf '%s' 'mot-de-passe-fort' | docker secret create quickpoll_db_password -
docker stack deploy -c stack.yml quickpoll
API_TAG=v2 docker stack deploy -c stack.yml quickpoll
API_TAG=v3 docker stack deploy -c stack.yml quickpoll
docker service inspect quickpoll_api --format '{{.UpdateStatus.State}}'
```
