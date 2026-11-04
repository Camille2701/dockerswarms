# TP 5 — Sauvegarde et restauration de QuickPoll

## Résumé

| Mesure | Résultat |
|---|---|
| RPO mesuré (perte de nœud) | **36 s, soit 72 votes perdus** |
| RTO mesuré (perte de nœud) | **3 min 27 s** (207 s), dont 101 s dues à une erreur de script, détaillée à l'étape 6 |
| Bascule planifiée | **Aucun vote perdu**, votes refusés pendant **32 s environ** |
| Sauvegarde | 1 par minute, 10 fichiers conservés |

Les sorties brutes sont dans [`captures/`](captures/).

## Environnement

- Cluster Swarm de 3 nœuds : `manager1`, `worker1`, `worker2`. Ce sont des conteneurs `docker:dind` sur une seule machine (OrbStack). `docker stop worker2` simule bien la perte d'un nœud, mais pas une vraie panne réseau entre plusieurs hôtes.
- Pendant les tests, le registry a été fixé sur `manager1` avec un volume. Sans volume, il perdait toutes les images à chaque déplacement.

### Écarts avec le sujet

Le TP a été réalisé sur le QuickPoll du TP précédent :

| Sujet | Ce dépôt |
|---|---|
| `hammer.sh`, premier `00` | `curl-loop.sh`, premier `200` (interroge `/api/version`) |
| `/api/poll` | `/api/results` |
| `/api/info` | `/api/version` |
| `quickpoll.localhost:8080` | `http://192.168.158.2:8080` (IP de `manager1`) |
| Images en `1.0` | `quickpoll-api:v2`, `quickpoll-front:v1` |
| 4 services | 6 services : `redis` et `worker` sont conservés |

**Conséquences :**
- Les votes passent par la file Redis : elle doit être vide avant une sauvegarde planifiée.
- Le healthcheck de l'API exécute `SELECT 1`. Sans base, toute l'API tombe, y compris `/api/version`.
- Le sujet a été modifié : `backup` doit tourner sur un autre nœud que la base. La base démarrant sur `manager1`, `backup` a d'abord été placé sur `worker1`, puis déplacé sur `manager1` après l'étape 5 pour atteindre l'état final attendu.

## Où vivent les données

État final :

| Donnée | Service | Nœud | Volume |
|---|---|---|---|
| Votes | `db` | `worker1` | `quickpoll_db-data` |
| Sauvegardes | `backup` | `manager1` | `quickpoll_backups` |
| Images | `registry` | `manager1` | `registry-data` |
| File de votes | `redis` | variable | Aucun : la file est perdue si Redis redémarre |

`worker2` garde aussi `quickpoll_pgdata`, l'ancienne base Postgres 16 du TP précédent. Elle n'est plus utilisée.

## Runbook : sauvegarder et restaurer

Commandes à lancer sur le manager.

### Vérifier les sauvegardes

```sh
docker service logs --tail 5 quickpoll_backup
docker service ps quickpoll_backup --filter desired-state=running
```

### Sauvegarder à la demande

```sh
docker service create --name dump --mode replicated-job \
  --network quickpoll_back --secret db_password \
  --constraint node.labels.backup==true \
  --mount type=volume,source=quickpoll_backups,target=/backups \
  postgres:17-alpine sh -c 'export PGPASSWORD="$(cat /run/secrets/db_password)";
    pg_dump -h db -U quickpoll -d quickpoll -Fc -f /backups/bascule.dump'
docker service ls --filter name=dump     # attendre "1/1 completed"
docker service rm dump
```

### Restaurer la dernière sauvegarde

```sh
docker service scale quickpoll_backup=0 quickpoll_api=0 quickpoll_worker=0

docker service create --name restore --mode replicated-job \
  --network quickpoll_back --secret db_password \
  --constraint node.labels.backup==true \
  --mount type=volume,source=quickpoll_backups,target=/backups \
  postgres:17-alpine sh -c 'export PGPASSWORD="$(cat /run/secrets/db_password)";
    f=$(ls -1t /backups/*.dump | head -1); echo "restoring $f";
    pg_restore -h db -U quickpoll -d quickpoll --clean --if-exists "$f"'
docker service ls --filter name=restore  # attendre "1/1 completed"
docker service logs restore
docker service rm restore

docker service scale quickpoll_worker=1 quickpoll_api=3 quickpoll_backup=1
curl -s http://127.0.0.1:8080/api/results
```

> **Piège : arrêter `backup` avant de créer une nouvelle base.** Sinon il sauvegarde la base vide avec succès, cette sauvegarde devient la plus récente, et `ls -1t | head -1` restaure du vide.

### Reprendre après la perte du nœud de la base

Remplacer `worker2` par le nœud perdu et `worker1` par le nœud de secours (différent du nœud de `backup`).

```sh
docker service scale quickpoll_backup=0 quickpoll_api=0 quickpoll_worker=0
docker node update --label-rm db worker2
docker node update --label-add db=true worker1

# Attendre que la tâche soit en Running sur worker1.
# Ne pas attendre "1/1" : un nœud Down fausse le compteur (2/1 observé).
docker service ps quickpoll_db --filter desired-state=running
```

Lancer ensuite le job `restore` ci-dessus, puis relancer `worker`, `api` et `backup`.

## Procédure de bascule (étape 5)

Objectif : déplacer la base de `manager1` vers `worker2` sans perdre de vote.

La procédure a été écrite avant d'être jouée, sauf l'étape 5 ci-dessous, corrigée après coup (voir le résultat de l'étape 5).

1. **Bloquer les votes :** `docker service scale quickpoll_api=0`.
2. **Vider la file**, sur le nœud de Redis : `LLEN votes` doit valoir 0.
   ```sh
   docker exec $(docker ps -qf name=quickpoll_redis) redis-cli LLEN votes
   ```
3. **Sauvegarder à la demande** avec le job `dump` du runbook.
4. **Arrêter le worker et les sauvegardes :**
   ```sh
   docker service scale quickpoll_worker=0 quickpoll_backup=0
   ```
5. **Supprimer le volume périmé**, sur le nœud cible. Les conteneurs arrêtés bloquent sa suppression :
   ```sh
   docker ps -aq --filter name=quickpoll_db | xargs -r docker rm -f
   docker volume rm quickpoll_db-data
   ```
6. **Déplacer les étiquettes :**
   ```sh
   docker node update --label-rm db manager1
   docker node update --label-add db=true worker2
   ```
7. **Attendre la base saine :** `docker service ps quickpoll_db --filter desired-state=running`.
8. **Restaurer** `/backups/bascule.dump` avec le job `restore` du runbook.
9. **Rouvrir :** `docker service scale quickpoll_worker=1 quickpoll_api=3 quickpoll_backup=1`.
10. **Vérifier** que le total de votes est identique, puis supprimer l'ancien volume sur `manager1`, de la même façon qu'à l'étape 5.

## Réponses

### Étape 1 — Où sont les données ?

`quickpoll_db-data` n'existe que sur **`manager1`** ([capture](captures/etape1-volumes.txt)), le nœud qui exécute la base. Un volume `local` est créé uniquement sur le nœud où une tâche en a besoin : Swarm ne le crée pas à l'avance et ne le réplique pas.

`Mountpoint` vaut `/var/lib/docker/volumes/quickpoll_db-data/_data`. Il contient le répertoire de données de Postgres : `PG_VERSION`, `base`, `global`, `pg_wal`, `pg_hba.conf`, `postgresql.conf`, etc.

### Étape 2 — Le déménagement raté

- **La tâche :** l'ancienne est refusée (`assigned node no longer meets constraints`) et une nouvelle démarre sur `worker2`.
- **Les votes :** QuickPoll passe de 10 votes à **0** (`"results":[]`).
- **Les volumes :** `quickpoll_db-data` existe alors sur `manager1` **et** sur `worker2`. Ce sont deux volumes distincts qui portent le même nom.
- **Retour sur `manager1` : oui, les 10 votes reviennent.** Ils n'avaient jamais quitté le volume de `manager1`. Swarm a déplacé le conteneur, pas les données. Un vote reçu pendant le passage sur `worker2` serait resté sur ce nœud.

[Capture](captures/etape2-demenagement-rate.txt).

### Étape 3 — Le service de sauvegarde

Vérifié : une ligne `saved` par minute, aucun échec, et **10 fichiers conservés pour 12 sauvegardes écrites** ([capture](captures/etape3-retention.txt)).

- **Pourquoi `.tmp` puis renommage ?** Le dump prend du temps, et un arrêt en cours laisserait un fichier incomplet. Le renommage est atomique sur un même système de fichiers : un fichier `.dump` est donc toujours complet, et la restauration comme la rotation ne voient jamais de sauvegarde partielle.
- **Pourquoi sur un autre nœud ?** Le volume est local. Sur le même nœud, sa perte emporterait à la fois la base et ses sauvegardes. Cela protège aussi du disque plein ou corrompu. La protection reste limitée tant que les sauvegardes ne sortent pas du cluster.

### Étape 4 — Une restauration

| Moment | Votes |
|---|---|
| Après les 5 premiers votes | 15 |
| Sauvegarde de 15:39:57 | 15 |
| Après les 5 votes suivants | 20 |
| **Après restauration** | **15** |

- **Votes perdus :** les 5 votes émis après la sauvegarde.
- **RPO maximal :** environ **60 s**, plus la durée du `pg_dump` (moins d'une seconde ici) : un vote arrivé juste après le début d'un dump attend le suivant.
- **`docker service ls`** affiche le mode `replicated job` et `0/1 (1/1 completed)` : aucune tâche active, une exécution terminée avec succès.
- **Avec un service `replicated` classique :** non testé. Swarm voudrait maintenir une tâche active et relancerait le conteneur dès la fin de la restauration. La restauration tournerait en boucle, et chaque passage effacerait les votes reçus entre-temps.

[Capture](captures/etape4-restauration.txt).

### Étape 5 — Le déménagement réussi

Résultat : **15 votes avant, 15 votes après**. Toute la bascule a duré 33 s, de 15:50:27 à 15:51:00.

| Heure | Action |
|---|---|
| 15:50:27 | `api=0` |
| 15:50:35 | File Redis vide, dump lancé |
| 15:50:37 | Dump terminé, étiquettes déplacées |
| 15:50:49 | Base démarrée sur `worker2` |
| 15:50:53 | Restauration terminée |
| 15:51:00 | Premier `200` |

- **Votes refusés pendant environ 32 s** (`ko` de 15:50:28 à 15:50:59, [capture](captures/etape5-bascule.txt)).
- **Comment éviter un vote entre la sauvegarde et la bascule ?** En arrêtant l'API **avant** la sauvegarde, puis en attendant que la file Redis soit vide. Plus aucune écriture ne peut alors arriver. C'est l'interruption qui garantit la cohérence.

**Écart avec la procédure initiale :** `docker volume rm` a échoué sur `worker2` (`volume is in use`), à cause des conteneurs arrêtés de l'étape 2. La base n'est donc pas repartie vide, et c'est `pg_restore --clean` qui a remplacé son contenu. Le résultat est correct, mais pas pour la raison prévue. L'étape 5 de la procédure a été corrigée, et le correctif a été validé en supprimant l'ancien volume de `manager1`. La procédure corrigée n'a pas été rejouée de bout en bout.

### Étape 6 — La panne du nœud de la base

**État à 1 minute** ([capture](captures/etape6-panne.txt)) :

```text
worker2 Down Active
quickpoll_db.1 |  | Running | Pending 51 seconds ago | "no suitable node (scheduling …"
quickpoll_api 1/3 (max 2 per node)
page HTTP 200
/api/version HTTP 502
/api/results HTTP 502
```

- **Pourquoi la base ne redémarre-t-elle pas toute seule ?** La tâche reste `Pending` : seul `worker2` porte `db=true`. Sans cette contrainte, elle repartirait de toute façon sur un volume vide. Swarm ne peut pas décider seul de changer de nœud, car les données n'y sont pas.
- **Le site est-il entièrement en panne ?** Non, mais presque : la page statique répond 200, tandis que `/api/version` et `/api/results` renvoient 502. L'application est inutilisable. Le service `backup` continue de tourner, mais ses sauvegardes échouent (`backup FAILED`).

**Mesures** ([sonde](captures/etape6-sonde.txt), [reprise](captures/etape6-reprise.txt)) :

| Repère | Heure |
|---|---|
| Dernière sauvegarde | 15:52:39 |
| Panne | 15:53:15 |
| Début de la reprise | 15:54:47 |
| Base prête sur `worker1` | 15:54:52 |
| Restauration lancée | 15:56:33 |
| Premier `200` | 15:56:42 |

- **RTO mesuré : 207 s (3 min 27 s).** Ce chiffre contient 101 s perdues par une erreur de script : la boucle d'attente visait `1/1`, alors que Swarm affichait `2/1` en comptant encore la tâche du nœud mort. Sans cette erreur, le RTO serait d'environ **106 s**. Cette dernière valeur est calculée, pas mesurée.
- **RPO mesuré : 36 s**, entre la dernière sauvegarde et la panne.
- **Votes perdus : 72** (144 écrits en base d'après les logs horodatés du worker, 72 présents dans la sauvegarde restaurée, avec deux boucles de vote simultanées, soit 2 votes par seconde).
- Les 92 s entre la panne et la reprise correspondent aux observations demandées. En production, ce serait le temps de détection et de décision.

**Retour de `worker2`** ([capture](captures/etape6-retour-worker2.txt)) :

- **Son ancien volume** est toujours là et intact (46,3 Mo). Swarm ne le supprime pas, ne le synchronise pas et ne l'utilise plus. `worker2` redevient `Ready` sans reprendre de tâche.
- **Le risque si `db=true` était resté :** deux nœuds seraient éligibles. Au prochain redémarrage, la base pourrait repartir sur l'ancien volume, sans aucune erreur, et les votes reçus depuis la panne sembleraient disparaître.
- **Nettoyage effectué :** étiquette déjà retirée, conteneurs arrêtés supprimés, puis volume supprimé.

### Étape 7 — Deux bases ?

Non déployé. Avec `replicas: 2`, on obtiendrait **deux serveurs Postgres indépendants**, chacun avec son propre volume, sans aucune réplication entre eux. Le VIP Swarm répartirait les connexions : un vote irait dans une base, le suivant dans l'autre. Les totaux changeraient d'une requête à l'autre et les données divergeraient, sans aucune erreur visible.

Si les deux tâches partageaient le même dossier, ce serait pire : deux serveurs écrivant les mêmes fichiers corrompraient la base.

La bonne solution est une **réplication gérée par la base** : un primaire pour les écritures, un ou plusieurs réplicas en streaming, et un outil de bascule automatique comme Patroni. Une base managée fait la même chose à notre place. On y ajoute un point d'accès stable vers le primaire et on garde les sauvegardes, car la réplication copie aussi les erreurs.

## Limites

- Les sauvegardes restent dans le cluster : si `manager1` disparaît aussi, il ne reste rien.
- La restauration n'a pas été testée de façon automatique : aucun job ne vérifie les fichiers.
- Le RPO de 36 s dépend du moment de la panne, entre 0 et 60 s environ.
