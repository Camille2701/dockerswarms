# TP 01 - Initialisation Docker Swarm & Test de Résilience

## 1. Topologie du cluster
* **Manager (1) :** `manager1` (Docker Engine v29.8.2) — Rôle : Leader
* **Workers (2) :** `worker1`, `worker2` (Docker Engine v29.8.2)
* **Système hôte / Environnement :** macOS (OrbStack) exécutant 3 nœuds via Docker-in-Docker (DinD)

## 2. Commandes d'initialisation et de jonction
**Initialisation du cluster sur le Manager :**
  ```bash
  docker exec -it manager1 docker swarm init
  ```

**Jonction des nœuds Workers :**
```bash
docker exec -it worker1 docker swarm join --token SWMTKN-1-xxxxxxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxx manager1:2377
docker exec -it worker2 docker swarm join --token SWMTKN-1-xxxxxxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxx manager1:2377

```



## 3. Simulation de la panne

1. **Déploiement du service web à 4 réplicas :**
```bash
docker exec -it manager1 docker service create --name web --replicas 4 nginx

```


2. **Arrêt brutal du worker :**
La panne a été simulée depuis la machine hôte en coupant directement le conteneur du premier worker :
```bash
docker stop worker1

```



## 4. Analyse de la replanification

* **Restauration des réplicas :** Dès que le statut de `worker1` est passé à `Down`, Docker Swarm a détecté la perte des tâches exécutées sur ce nœud.
* **Délai de récupération :** En environ **10 à 15 secondes**, Swarm a automatiquement replanifié et démarré 2 nouvelles tâches sur les nœuds restants (`manager1` et `worker2`) afin de maintenir l'état désiré de 4 réplicas actifs.

## 5. Analyse : Perte du Manager

Si le nœud Manager unique avait été coupé à la place d'un Worker :

* **Comportement des conteneurs :** Les réplicas existants sur les Workers auraient continué de tourner normalement sans interruption.
* **Perte du Control Plane :** Le cluster aurait perdu la capacité de gérer son état (impossibilité d'exécuter des commandes `docker service`, de scaler, ou de replanifier des tâches en cas de nouvelle panne).
* **Bonne pratique :** En environnement de production, il convient de déployer un nombre impair de Managers (au moins 3) afin de maintenir le quorum du protocole Raft et garantir la haute disponibilité du plan de contrôle.

```
