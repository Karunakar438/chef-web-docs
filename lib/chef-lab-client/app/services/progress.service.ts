import { Injectable } from '@angular/core'
import { Observable, BehaviorSubject, AsyncSubject } from 'rxjs'
import { UserProfileService } from './user-profile.service'
import { Angular2TokenService } from 'angular2-token'
type LearningType = 'achievements' | 'tracks' | 'modules' | 'units'
interface Learning { started_at?: string, completed_at?: string }

@Injectable()
export class ProgressService {
  public activeUserProgress: BehaviorSubject<any> = new BehaviorSubject({})
  private isAuthenticated = false
  private wasAnonymous = false

  constructor(
    private userProfileService: UserProfileService,
    private _tokenService: Angular2TokenService,
  ) {
  }

  init() {
    this.userProfileService.isAuthenticated().subscribe((next) => {
      this.isAuthenticated = next
      if (!this.isAuthenticated) {
        this.wasAnonymous = true
      }
      this.initUserProgressData()
    })
  }

  public getLearningType(pageId: string): LearningType {
    if (pageId === 'modules' || pageId === 'tracks') return
    const moduleId = this.getModuleRoot(pageId)
    if (pageId === moduleId) return 'modules'
    if (moduleId) return 'units'
    const trackData = (window as any).dataTree.tracks
    if (trackData[pageId]) return 'tracks'
  }

  public startPage(pageId) {
    const observables = []
    const learningType = this.getLearningType(pageId)
    observables.push(this.updateField(learningType, pageId, { 'started_at': new Date().toISOString() }))
    // Also track modules as unit pages; see details under completePage()
    if (learningType === 'modules') {
      observables.push(this.updateField('units', pageId, { 'started_at': new Date().toISOString() }))
    }
    return Observable.merge(...observables)
  }

  public completePage(pageId: string) {
    const learningType = this.getLearningType(pageId)
    // Modules are treated as both unit pages (i.e. the individual page at the module URL) and as
    // groups of zero or more unit pages, typically known as modules.
    // Only unit pages (and module pages being treated as unit pages) can be directly completed;
    // other types are completed conditionally
    if (learningType !== 'units' && learningType !== 'modules') return Observable.from([])
    return this.updateField('units', pageId, { 'completed_at': new Date().toISOString() })
      .concat(
        this.completeModule(pageId),
        this.completeTracks(),
        this.awardAchievements(),
      )
  }

  public getAchievements(id?: string): Object {
    const data = this.getUserProgressData('achievements')
    if (id) return data[id]
    return data
  }

  private completeModule(pageId: string) {
    const moduleId = this.getModuleRoot(pageId)
    const currentState = this.getUserProgressData('modules', moduleId)
    const newData = <Learning> {}
    if (!currentState.started_at) newData.started_at = new Date().toISOString()
    if (!currentState.completed_at && this.getModuleProgress(pageId) >= 100) {
      newData.completed_at = new Date().toISOString()
    }
    if (newData) return this.updateField('modules', moduleId, newData)
    return Observable.from([])
  }

  private completeTracks() {
    const observables = []
    const trackData = (window as any).dataTree.tracks
    Object.keys(trackData).forEach(trackId => {
      if (trackData[trackId].modules) {
        const modulesComplete = trackData[trackId].modules.filter(moduleId => {
          return this.getUserProgressData('modules', moduleId).completed_at
        })
        if (trackData[trackId].modules.length === modulesComplete.length) {
          const currentState = this.getUserProgressData('tracks', trackId)
          const newData = <Learning> {}
          if (!currentState.started_at) newData.started_at = new Date().toISOString()
          if (!currentState.completed_at) newData.completed_at = new Date().toISOString()
          if (newData) observables.push(this.updateField('tracks', trackId, newData))
        }
      }
    })
    return Observable.merge(...observables)
  }

  private awardAchievements() {
    const modulesData = this.getUserProgressData('modules')
    const tracksData = this.getUserProgressData('tracks')
    const achievementsData = this.getUserProgressData('achievements')
    const observables = []

    // If any modules have been completed, grant the special edition "grand opening" coaster
    if (Object.keys(modulesData).filter((id) => { return modulesData[id].completed_at }).length > 0) {
      if (!achievementsData['grand-opening']) {
        observables.push(this.updateField('achievements', 'grand-opening', {
          'achievement_type': 'standard',
          'earned_at': new Date().toISOString(),
        }))
      }
    }

    // If any tracks have been completed, grant the track coasters
    const completedTracks = Object.keys(tracksData).filter((id) => { return tracksData[id].completed_at })
    completedTracks.forEach(trackId => {
      if (!achievementsData[trackId]) {
        observables.push(this.updateField('achievements', trackId, {
          'achievement_type': 'standard',
          'earned_at': new Date().toISOString(),
        }))
      }
    })

    return Observable.merge(...observables)
  }

  public isComplete(learningType: LearningType, pageId: string | void) {
    if (!pageId) return false
    const data = this.getUserProgressData(learningType, pageId)
    return data && data.completed_at
  }

  public getLastAccessed(learningType: LearningType, pageId: string) {
    const data = this.getUserProgressData(learningType, pageId, true)
    const sorted = Object.keys(data).sort((a, b) => {
      const dateA = [data[a].started_at, data[a].completed_at].sort().reverse()[0]
      const dateB = [data[b].started_at, data[b].completed_at].sort().reverse()[0]
      return (dateA > dateB) ? -1 : 1
    })
    return data[sorted[0]] && {...{ id: sorted[0] }, ...data[sorted[0]] }
  }

  public getModuleProgress(pageId: string): number {
    const moduleData = (window as any).dataTree.modules

    // Determine the active item from which to generate time estimates
    // See if the item passed is the current path, or the module root
    if (!moduleData[pageId]) return 0
    let activeItemId = pageId
    if (moduleData[pageId].parent === 'modules') {
      // Get the user's current path through this module or track
      // TODO: Consider validating the last started item to ensure it follows the last completed
      const lastAccessed = this.getLastAccessed('modules', pageId)
      if (lastAccessed) activeItemId = lastAccessed.id
    }

    // Get all the module IDs within the active path (parents, siblings, and children)
    const activePathIds = this.getActivePathIds(activeItemId)

    // Get the base time for the current path
    const currentPageData = moduleData[activeItemId]
    if (!currentPageData) return 0
    const baseTimeRange = [0, 0]

    // Use the parent of the current item for finding children and siblings, unless the parent is a multipage
    let parent = currentPageData.parent
    const childRoot = (parent && !moduleData[parent].is_fork) ? parent : activeItemId
    if (moduleData[childRoot].remaining) {
      baseTimeRange[0] += moduleData[childRoot].remaining[0]
      baseTimeRange[1] += moduleData[childRoot].remaining[1]
    }

    // Add parent path time
    if (moduleData[childRoot] && moduleData[childRoot].parent) {
      parent = moduleData[childRoot].parent
      while (parent && parent !== 'modules') {
        const parentData = moduleData[parent]
        if (parentData.minutes) {
          baseTimeRange[0] += parentData.minutes[0]
          baseTimeRange[1] += parentData.minutes[1]
        }
        parent = parentData.parent
      }
    }

    const baseTimeAvg = baseTimeRange.reduce((a, b) => { return a + b }) / baseTimeRange.length

    // Add up the the user's time completed for the current path
    const moduleId = this.getModuleRoot(pageId)
    const userData = this.getUserProgressData('units', moduleId, true)
    const complete = Object.keys(userData).filter(key => {
      return userData[key].completed_at
    })
    let userCompletedAvg = 0
    const activePathIdsCompleted = complete.filter(completeId => {
      const inPath = activePathIds.indexOf(completeId) > -1
      if (inPath) {
        const completeItem = moduleData[completeId]
        if (completeItem) {
          const completedTimeRange = completeItem.minutes || [0, 0]
          const completedTimeAvg = completedTimeRange.reduce((a, b) => { return a + b }) / completedTimeRange.length
          userCompletedAvg += completedTimeAvg
        }
      }
      return inPath
    })

    // If there isn't any base time, we'll figure progress by number of units completed
    if (baseTimeAvg) {
      return Math.min(100, Math.max(0, Math.round(100 * userCompletedAvg / baseTimeAvg)))
    } else {
      return Math.min(100, Math.max(0, Math.round(100 * activePathIdsCompleted.length / activePathIds.length)))
    }
  }

  private getActivePathIds(activeItemId: string): Array<string> {
    const moduleData = (window as any).dataTree.modules
    let ids = []
    if (!moduleData[activeItemId]) return ids

    // Use the parent of the current item for finding children and siblings, unless the parent is a multipage
    let parent = moduleData[activeItemId].parent
    const childRoot = (parent && !moduleData[parent].is_fork) ? parent : activeItemId
    ids.unshift(childRoot)

    // Add parent path IDs
    if (moduleData[childRoot] && moduleData[childRoot].parent) {
      parent = moduleData[childRoot].parent
      while (parent && parent !== 'modules') {
        ids.unshift(parent)
        parent = moduleData[parent].parent
      }
    }

    // Add sibling and child items
    ids = ids.concat(this.getChildPathIds(childRoot))
    return ids
  }

  private getChildPathIds(pageId: string): Array<string> {
    const moduleData = (window as any).dataTree.modules
    let ids = []
    if (moduleData[pageId] && moduleData[pageId].children) {
      moduleData[pageId].children.forEach((child) => {
        ids.push(child)
        ids = ids.concat(this.getChildPathIds(child))
      })
    }
    return ids
  }

  public getModuleRoot(pageId: string): string {
    const moduleData = (window as any).dataTree.modules
    let moduleRoot = moduleData[pageId]
    if (!moduleRoot) return
    while (moduleRoot.parent && moduleRoot.parent !== 'modules') {
      pageId = moduleRoot.parent
      moduleRoot = moduleData[pageId]
    }
    return pageId
  }

  public getTracksByModule(moduleId: string): string | void {
    const tracksData = (window as any).dataTree.tracks
    return tracksData.tracks.children.filter(trackId => {
      return tracksData[trackId].modules.some(trackModuleId => {
        return (trackModuleId === moduleId)
      })
    })
  }

  // Should match the Ruby implementation: find_get_page() in page_helper.rb
  public getNextPage(pageId: string): string | void {
    const moduleData = (window as any).dataTree.modules
    if (!moduleData[pageId]) return
    if (moduleData[pageId].children) {
      return moduleData[pageId].children[0]
    } else if (moduleData[pageId].parent) {
      const parentId = moduleData[pageId].parent
      if (parentId === 'modules') return
      const parent = moduleData[parentId]
      const index = parent.children.indexOf(pageId)
      return parent.children[index + 1]
    }
  }

  private updateField(learningType: LearningType, pageId: string, fieldValues: object) {
    const dataLocal = this.activeUserProgress.getValue()

    // Build full and partial data objects
    dataLocal[learningType] = dataLocal[learningType] || {}
    dataLocal[learningType][pageId] = dataLocal[learningType][pageId] || {}
    const dataChange = {}
    dataChange[learningType] = {}
    dataChange[learningType][pageId] = Object.assign({}, dataLocal[learningType][pageId])
    Object.assign(dataChange[learningType][pageId], fieldValues)
    Object.assign(dataLocal[learningType][pageId], fieldValues)

    // Update local storage with the full data object
    localStorage.setItem('userProgressInfo', JSON.stringify(dataLocal))

    // If not logged in, skip the API call
    if (!this.isAuthenticated) {
      this.activeUserProgress.next(dataLocal)
      return Observable.from([])
    }

    // Update the server with a partial objects of changes
    const httpObservable = this._tokenService.put('api/v1/progress', dataChange).share()

    // Register all handlers to make RxJS catch exceptions, which other subscribers may need
    // See https://github.com/ReactiveX/rxjs/issues/2145
    httpObservable.subscribe(
      () => {},
      res => {
        // TODO: Revisit and refine this behavior, but ensure that a user who's logged out
        // as far as the server is concerned doesn't stay "logged in" on the client.
        if (res.status === 401) {
          this.userProfileService.signOut()
        }
        this.activeUserProgress.next(dataLocal)
      },
      () => {
        this.activeUserProgress.next(dataLocal)
      },
    )

    return httpObservable
  }

  private getUserProgressData(learningType?: LearningType, pageId?: string, wildcard?: boolean): Learning {
    let data = this.activeUserProgress.getValue()
    if (learningType) {
      data = data[learningType] || {}
      if (pageId) {
        if (wildcard) {
          const ret = {}
          Object.keys(data).forEach(key => {
            if (key.match(new RegExp('^' + pageId + '(\/.+)?$'))) {
              ret[key] = data[key]
            }
          })
          return ret
        } else {
          return data[pageId] || {}
        }
      }
    }
    return data
  }

  private initUserProgressData() {
    let existing: Object
    try {
      existing = JSON.parse(localStorage.getItem('userProgressInfo')) || {}
    } catch (e) {
      existing = {}
    }
    const pageId = (window as any).currentPage.id

    if (!this.isAuthenticated) {
      this.activeUserProgress.next(existing)
      this.startPage(pageId)
      return Observable.from([])
    }

    // Transfer all local progress to the server
    if (this.wasAnonymous) {
      Object.keys(existing).forEach(learningType => {
        Object.keys(existing[learningType]).forEach(id => {
          this.updateField(learningType as LearningType, id, existing[learningType][id])
        })
      })
      this.wasAnonymous = false
    }

    return this._tokenService.get('api/v1/progress').map(res => res.json()).subscribe(
      res => {
        localStorage.setItem('userProgressInfo', JSON.stringify(res))
        this.activeUserProgress.next(res)
        this.startPage(pageId)
      },
      error => {
        console.log('Error getting user progress from the database', error)
        this.activeUserProgress.next(existing)
        this.startPage(pageId)
      },
    )
  }
}
